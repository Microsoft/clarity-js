import compress from "./compress";
import { createCompressionWorker } from "./compressionworker";
import { config } from "./config";
import getPlugin from "./plugins";
import { debug, getCookie, guid, isNumber, mapProperties, setCookie } from "./utils";

// Constants
const version = "0.1.10";
const ImpressionAttribute = "data-iid";
const UserAttribute = "data-cid";
const Cookie = "ClarityID";
export const ClarityAttribute = "clarity-iid";

// Variables
let sentBytesCount: number;
let cid: string;
let impressionId: string;
let sequence: number;
let eventCount: number;
let startTime: number;
let activePlugins: IPlugin[];
let bindings: IBindingContainer;
let timeout: number;
let compressionWorker: Worker;
let envelope: IEnvelope;

// Storage for payloads that were not delivered for re-upload
let droppedPayloads: { [key: number]: IDroppedPayloadInfo };

// Storage for events that were posted to compression worker, but have not returned to core as compressed batches yet.
// When page is unloaded, keeping such event copies in core allows us to terminate compression worker safely and then
// compress and upload remaining events synchronously from the main thread.
let pendingEvents: IEvent[] = [];

export let state: State = State.Loaded;

export function activate() {
  if (init()) {
    document[ClarityAttribute] = impressionId;
    for (let plugin of config.plugins) {
      let pluginClass = getPlugin(plugin);
      if (pluginClass) {
        let instance = new (pluginClass)();
        instance.reset();
        instance.activate();
        activePlugins.push(instance);
      }
    }

    bind(window, "beforeunload", teardown);
    bind(window, "unload", teardown);
    state = State.Activated;
  }
}

export function teardown() {
  for (let plugin of activePlugins) {
    plugin.teardown();
  }

  // Walk through existing list of bindings and remove them all
  for (let evt in bindings) {
    if (bindings.hasOwnProperty(evt)) {
      let eventBindings = bindings[evt] as IEventBindingPair[];
      for (let i = 0; i < eventBindings.length; i++) {
        (eventBindings[i].target).removeEventListener(evt, eventBindings[i].listener);
      }
    }
  }

  delete document[ClarityAttribute];
  if (compressionWorker) {
    // Immediately terminate the worker and kill its thread.
    // Any possible pending incoming messages from the worker will be ignored in the 'Unloaded' state.
    // Copies of all the events that were sent to the worker, but have not been returned as a compressed batch yet,
    // are stored in the 'pendingEvents' queue, so we will compress and upload them synchronously in this thread.
    compressionWorker.terminate();
  }
  state = State.Unloaded;

  // Instrument teardown and upload residual events
  instrument({ type: Instrumentation.Teardown });
  uploadPendingEvents();
}

export function bind(target: EventTarget, event: string, listener: EventListener) {
  let eventBindings = bindings[event] || [];
  target.addEventListener(event, listener, false);
  eventBindings.push({
    target,
    listener
  });
  bindings[event] = eventBindings;
}

export function addEvent(event: IEventData, scheduleUpload: boolean = true) {
  let evt: IEvent = {
    id: eventCount++,
    time: isNumber(event.time) ? event.time : getTimestamp(),
    type: event.type,
    state: event.state
  };
  let addEventMessage: IAddEventMessage = {
    type: WorkerMessageType.AddEvent,
    event: evt,
    time: getTimestamp()
  };
  compressionWorker.postMessage(addEventMessage);
  pendingEvents.push(evt);
  if (scheduleUpload) {
    clearTimeout(timeout);
    timeout = setTimeout(forceCompression, config.delay);
  }
}

export function addMultipleEvents(events: IEventData[]) {
  if (events.length > 0) {
    // Don't schedule upload until we add the last event
    for (let i = 0; i < events.length - 1; i++) {
      addEvent(events[i], false);
    }
    let lastEvent = events[events.length - 1];
    addEvent(lastEvent, true);
  }
}

export function forceCompression() {
  let forceCompressionMessage: ITimestampedWorkerMessage = {
    type: WorkerMessageType.ForceCompression,
    time: getTimestamp()
  };
  compressionWorker.postMessage(forceCompressionMessage);
}

export function getTimestamp(unix?: boolean, raw?: boolean) {
  let time = unix ? getUnixTimestamp() : getPageContextBasedTimestamp();
  return (raw ? time : Math.round(time));
}

export function instrument(eventState: IInstrumentationEventState) {
  if (config.instrument) {
    addEvent({type: "Instrumentation", state: eventState});
  }
}

export function onWorkerMessage(evt: MessageEvent) {
  if (state !== State.Unloaded) {
    let message = evt.data;
    switch (message.type) {
      case WorkerMessageType.CompressedBatch:
        let uploadMsg = message as ICompressedBatchMessage;
        let onSuccess = (status: number) => { mapProperties(droppedPayloads, uploadDroppedPayloadsMappingFunction, true); };
        let onFailure = (status: number) => { onFirstSendDeliveryFailure(status, uploadMsg.rawData, uploadMsg.compressedData); };
        upload(uploadMsg.compressedData, onSuccess, onFailure);

        // Clear local copies for the events that just came in a compressed batch from the worker.
        // Since the order of messages is guaranteed, events will be coming from the worker in the
        // exact same order as they were pushed on the pendingEvents queue and sent to the worker.
        // This means that we can just pop 'eventCount' number of events from the front of the queue.
        pendingEvents.splice(0, uploadMsg.eventCount);
        sequence++;
        if (config.debug) {
          let env = JSON.parse(uploadMsg.rawData).envelope as IEnvelope;
          let compressedKb = Math.ceil(uploadMsg.compressedData.length / 1024.0);
          let rawKb = Math.ceil(uploadMsg.rawData.length / 1024.0);
          debug(`** Clarity #${env.sequenceNumber}: Uploading ${compressedKb}KB (raw: ${rawKb}KB). **`);
        }
        break;
      default:
        break;
    }
  }
}

function getUnixTimestamp(): number {
  return (window.performance && performance.now && performance.timing)
    ? performance.now() + performance.timing.navigationStart
    : new Date().getTime();
}

// If performance.now function is not available, we do our best to approximate the time since page start
// by using the timestamp from when Clarity script got invoked as a starting point.
// In such case this number may not reflect the 'time since page start' accurately,
// especially if Clarity script is post-loaded or injected after page load.
function getPageContextBasedTimestamp(): number {
  return (window.performance && performance.now)
    ? performance.now()
    : new Date().getTime() - startTime;
}

function uploadDroppedPayloadsMappingFunction(sequenceNumber: string, droppedPayloadInfo: IDroppedPayloadInfo) {
  let onSuccess = (status: number) => { onResendDeliverySuccess(droppedPayloadInfo); };
  let onFailure = (status: number) => { onResendDeliveryFailure(status, droppedPayloadInfo); };
  upload(droppedPayloadInfo.payload, onSuccess, onFailure);
}

function upload(payload: string, onSuccess?: UploadCallback, onFailure?: UploadCallback) {
  if (config.uploadHandler) {
    config.uploadHandler(payload, onSuccess, onFailure);
  } else {
    defaultUpload(payload, onSuccess, onFailure);
  }
  sentBytesCount += payload.length;
  if (state === State.Activated && sentBytesCount > config.totalLimit) {
    let totalByteLimitExceededEventState: ITotalByteLimitExceededEventState = {
      type: Instrumentation.TotalByteLimitExceeded,
      bytes: sentBytesCount
    };
    instrument(totalByteLimitExceededEventState);
    teardown();
  }
}

function defaultUpload(payload: string, onSuccess?: UploadCallback, onFailure?: UploadCallback) {
  if (config.uploadUrl.length > 0) {
    payload = JSON.stringify(payload);
    let xhr = new XMLHttpRequest();
    xhr.open("POST", config.uploadUrl);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = () => { onXhrReadyStatusChange(xhr, onSuccess, onFailure); };
    xhr.send(payload);
  }
}

function onXhrReadyStatusChange(xhr: XMLHttpRequest, onSuccess: UploadCallback, onFailure: UploadCallback) {
  if (xhr.readyState === XMLHttpRequest.DONE) {
    // HTTP response status documentation:
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
    if (xhr.status < 200 || xhr.status > 208) {
      onFailure(xhr.status);
    } else {
      onSuccess(xhr.status);
    }
  }
}

function onFirstSendDeliveryFailure(status: number, rawPayload: string, compressedPayload: string) {
  let sentObj: IPayload = JSON.parse(rawPayload);
  let xhrErrorEventState: IXhrErrorEventState = {
    type: Instrumentation.XhrError,
    requestStatus: status,
    sequenceNumber: sentObj.envelope.sequenceNumber,
    compressedLength: compressedPayload.length,
    rawLength: rawPayload.length,
    firstEventId: sentObj.events[0].id,
    lastEventId: sentObj.events[sentObj.events.length - 1].id,
    attemptNumber: 0
  };
  droppedPayloads[xhrErrorEventState.sequenceNumber] = {
    payload: compressedPayload,
    xhrErrorState: xhrErrorEventState
  };
  instrument(xhrErrorEventState);
  sentBytesCount -= compressedPayload.length;
}

function onResendDeliveryFailure(status: number, droppedPayloadInfo: IDroppedPayloadInfo) {
  droppedPayloadInfo.xhrErrorState.requestStatus = status;
  droppedPayloadInfo.xhrErrorState.attemptNumber++;
  instrument(droppedPayloadInfo.xhrErrorState);
}

function onResendDeliverySuccess(droppedPayloadInfo: IDroppedPayloadInfo) {
  delete droppedPayloads[droppedPayloadInfo.xhrErrorState.sequenceNumber];
}

function uploadPendingEvents() {
  if (pendingEvents.length > 0) {
    envelope.sequenceNumber = sequence++;
    envelope.time = getTimestamp();
    let raw = JSON.stringify({ envelope, events: pendingEvents });
    let compressed = compress(raw);
    let onSuccess = (status: number) => { /* Do nothing */ };
    let onFailure = (status: number) => { /* Do nothing */ };
    upload(compressed, onSuccess, onFailure);
  }
}

function init() {

  // Variables required to send minimal instrumentation events and teardown in case CheckAPI fails
  startTime = getUnixTimestamp();
  cid = getCookie(Cookie);
  impressionId = guid();
  sequence = 0;
  eventCount = 0;
  pendingEvents = [];
  sentBytesCount = 0;
  envelope = {
    clarityId: cid,
    impressionId,
    url: window.location.href,
    version
  };

  // If CID cookie isn't present, set it now
  if (!cid) {
    cid = guid();
    setCookie(Cookie, cid);
  }

  // If critical API is missing, don't activate Clarity
  if (!checkFeatures()) {
    teardown();
    return false;
  }

  // Check that no other instance of Clarity is already running on the page
  if (document[ClarityAttribute]) {
    let eventState: IClarityDuplicatedEventState = {
      type: Instrumentation.ClarityDuplicated,
      currentImpressionId: document[ClarityAttribute]
    };
    instrument(eventState);
    teardown();
    return false;
  }

  // Remaining local variablse
  activePlugins = [];
  bindings = {};
  droppedPayloads = {};
  compressionWorker = createCompressionWorker(envelope, onWorkerMessage);

  return true;
}

function checkFeatures() {
  let missingFeatures = [];
  let expectedFeatures = [
    "document.implementation.createHTMLDocument",
    "document.documentElement.classList",
    "Function.prototype.bind",
    "window.Worker"
  ];

  for (let feature of expectedFeatures) {
    let parts = feature.split(".");
    let api = window;
    for (let part of parts) {
      if (typeof api[part] === "undefined") {
        missingFeatures.push(feature);
        break;
      }
      api = api[part];
    }
  }

  if (missingFeatures.length > 0) {
    instrument({
      type: Instrumentation.MissingFeature,
      missingFeatures
    } as IMissingFeatureEventState);
    return false;
  }

  return true;
}

// Initialize bindings early, so that registering and wiring up can be done properly
bindings = {};
