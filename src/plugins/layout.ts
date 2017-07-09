import { config } from "./../config";
import { addEvent, bind, getTimestamp, instrument } from "./../core";
import { assert, debug, isNumber, traverseNodeTree } from "./../utils";
import { ShadowDom } from "./layout/shadowdom";
import { createGenericLayoutState, createLayoutState, getNodeIndex, IgnoreTag, NodeIndex } from "./layout/stateprovider";

export default class Layout implements IPlugin {
  private eventName = "Layout";
  private distanceThreshold = 5;
  private shadowDom: ShadowDom;
  private shadowDomConsistent: boolean;
  private observer: MutationObserver;
  private watchList: boolean[];
  private mutationSequence: number;
  private domDiscoverComplete: boolean;
  private domPreDiscoverMutations: ILayoutEventInfo[][];
  private lastConsistentDomJson: object;
  private originalProperties: {
    [key: number]: INodePreUpdateInfo
  };
  private originalLayouts: Array<{
    node: Node;
    layout: ILayoutState;
  }>;

  public reset(): void {
    this.shadowDom = new ShadowDom();
    this.shadowDomConsistent = false;
    this.watchList = [];
    this.observer = window["MutationObserver"] ? new MutationObserver(this.mutation.bind(this)) : null;
    this.mutationSequence = 0;
    this.domDiscoverComplete = false;
    this.originalLayouts = [];
    this.domPreDiscoverMutations = [];
    this.originalProperties = [];
    this.lastConsistentDomJson = {};
  }

  public activate(): void {
    this.discoverDom();
    if (this.observer) {
      this.observer.observe(document, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
        attributeOldValue: true,
        characterDataOldValue: true
      });
    }
  }

  public teardown(): void {
    if (this.observer) {
      this.observer.disconnect();
    }

    // Clean up node indices on observed nodes
    // If Clarity is re-activated within the same page later,
    // old, uncleared indices would cause it to work incorrectly
    let allNodes = this.shadowDom.doc.querySelectorAll("*");
    for (let i = 0; i < allNodes.length; i++) {
      let node = (allNodes[i] as IShadowDomNode).node;
      if (node) {
        delete node[NodeIndex];
      }
    }
  }

  // Recording full layouts of all elements on the page at once is an expensive operation
  // and can impact user's experience by hanging the page due to occupying the thread for too long
  // To avoid this, we only assign indices to all elements and build a ShadowDom with dummy layouts
  // just to have a valid DOM skeleton. After that, we can come back to dummy layouts and populate
  // them with real data asynchronously (if it takes too long to do at once) by yielding a thread
  // and returning to it later through a set timeout
  private discoverDom() {
    let discoverTime = getTimestamp();
    traverseNodeTree(document, this.discoverNode.bind(this));
    this.ensureConsistency("Discover DOM");
    setTimeout(() => {
      this.backfillLayoutsAsync(discoverTime, this.onDomDiscoverComplete.bind(this));
    }, 0);
  }

  // Add node to the ShadowDom to store initial adjacent node info in a layout and obtain an index
  private discoverNode(node: Node) {
    let layout = createGenericLayoutState(node, null);
    this.shadowDom.insertShadowNode(node, layout.parent, layout.next, layout);
    layout.index = getNodeIndex(node);
    this.originalLayouts.push({
      node,
      layout
    });
  }

  // Go back to the nodes that were stored with a dummy layout during the DOM discovery
  // and compute valid layouts for those nodes. Since there can be many layouts to process,
  // this function will yield a thread, if it is taking too long and will return to processing
  // remaining layouts ASAP through the setTimeout call.
  // Because of its potential async nature, it is possible that by the time we get to processing
  // a layout of some element, there has been a mutation on it, so its properties could have changed.
  // To handle this, until we record all initial layouts, MutationObserver's callback function will
  // evaluate whether some mutation changes node's attributes/characterData for the first time and,
  // if it does, store original values. Then, when we record the layout of the mutated node,
  // we can adjust the current layout JSON with the original values to mimic its initial state.
  private backfillLayoutsAsync(time: number, onDomDiscoverComplete: () => void) {
    let yieldTime = getTimestamp(true) + config.timeToYield;
    while (this.originalLayouts.length > 0 && getTimestamp(true) < yieldTime) {
      let originalLayout = this.originalLayouts.shift();
      let originalLayoutState = originalLayout.layout;
      let currentLayoutState = createLayoutState(originalLayout.node, this.shadowDom);
      let originalProperties = this.originalProperties[originalLayout.layout.index];

      currentLayoutState.index = originalLayout.layout.index;
      currentLayoutState.parent = originalLayoutState.parent;
      currentLayoutState.previous = originalLayoutState.previous;
      currentLayoutState.next = originalLayoutState.next;
      currentLayoutState.source = Source.Discover;
      currentLayoutState.action = Action.Insert;

      // If element is not ignored, override current layout with its original properties to recreate its original state
      if (originalProperties && currentLayoutState.tag !== IgnoreTag) {
        switch (originalLayout.node.nodeType) {
          case Node.TEXT_NODE:
            (currentLayoutState as ITextLayoutState).content = originalProperties.characterData;
            break;
          case Node.ELEMENT_NODE:
            let originalAttributes = originalProperties.attributes;
            for (let attr in originalAttributes) {
              if (originalAttributes.hasOwnProperty(attr)) {
                if (originalAttributes[attr] === null) {
                  delete (currentLayoutState as IElementLayoutState).attributes[attr];
                } else {
                  (currentLayoutState as IElementLayoutState).attributes[attr] = originalAttributes[attr];
                }
              }
            }
            break;
          default:
            break;
        }
      }

      addEvent(this.eventName, currentLayoutState, time);
    }

    // If there are more elements that need to be processed, yield the thread and return ASAP
    if (this.originalLayouts.length > 0) {
      setTimeout(() => {
        this.backfillLayoutsAsync(time, onDomDiscoverComplete);
      }, 0);
    } else {
      onDomDiscoverComplete();
    }
  }

  // Mark dom discovery process completed and process mutations that happened on the page up to this point
  private onDomDiscoverComplete() {
    this.domDiscoverComplete = true;
    for (let i = 0; i < this.domPreDiscoverMutations.length; i++) {
      let mutationEvents = this.domPreDiscoverMutations[i];
      for (let j = 0; j < mutationEvents.length; j++) {
        this.processNodeEvent(mutationEvents[j]);
      }
    }
  }

  // Looks at whether some node's attributes/characterData have mutated for the first time
  // and records the original values for later process of restoring that node's initial state
  private storeOriginalProperties(mutation: MutationRecord) {
    let targetIndex = getNodeIndex(mutation.target);
    assert(targetIndex !== null, "storeOriginalProperties", "targetIndex is null");
    if (targetIndex !== null) {
      let originalProperties = this.originalProperties[targetIndex] || {
        attributes: {},
        characterData: null
      };
      switch (mutation.type) {
        case "attributes":
          let originalAttributes = originalProperties.attributes;
          if (!(mutation.attributeName in originalAttributes)) {
            originalAttributes[mutation.attributeName] = mutation.oldValue;
          }
          break;
        case "characterData":
          if (originalProperties.characterData === null) {
            originalProperties.characterData = mutation.oldValue;
          }
          break;
        default:
          break;
      }
      this.originalProperties[targetIndex] = originalProperties;
    }
  }

  private processNodeEvent<T extends ILayoutEventInfo>(eventInfo: T) {
    let layoutState: ILayoutState = null;
    switch (eventInfo.action) {
      case Action.Insert:
        layoutState = this.processInsertEvent(eventInfo.node);
        break;
      case Action.Update:
        layoutState = this.processUpdateEvent(eventInfo.node);
        break;
      case Action.Remove:
        // Index is passed explicitly because indices on removed nodes are cleared,
        // so at this point we can't obtain node's index from the node itself
        layoutState = this.processRemoveEvent(eventInfo.node);
        layoutState.index = eventInfo.index;
        break;
      case Action.Move:
        layoutState = this.processMoveEvent(eventInfo.node);
        break;
      case Action.Ignore:
      default:
        break;
    }

    if (layoutState.tag !== IgnoreTag) {
      if (eventInfo.source === Source.Mutation) {
        layoutState.mutationSequence = this.mutationSequence;
      }
      layoutState.source = eventInfo.source;
      addEvent(this.eventName, layoutState);
    }
  }

  private processInsertEvent(node: Node): ILayoutState {
    let index = getNodeIndex(node);
    let layoutState = createLayoutState(node, this.shadowDom);
    layoutState.action = Action.Insert;
    this.shadowDom.getShadowNode(index).layout = layoutState;
    if (node.nodeType === Node.ELEMENT_NODE) {
      let styles = window.getComputedStyle(node as Element);
      if (styles.opacity !== "0" && styles.visibility !== "hidden") {
        this.watch(node as Element, layoutState as IElementLayoutState, styles);
      }
    }
    return layoutState;
  }

  private processUpdateEvent(node: Node): ILayoutState {
    let index = getNodeIndex(node);
    let layoutState = createLayoutState(node, this.shadowDom);
    layoutState.action = Action.Update;
    this.shadowDom.getShadowNode(index).layout = layoutState;
    return layoutState;
  }

  private processRemoveEvent(node: Node) {
    let layoutState = createLayoutState(node, this.shadowDom);
    layoutState.action = Action.Remove;
    return layoutState;
  }

  private processMoveEvent(node: Node): ILayoutState {
    let index = getNodeIndex(node);
    let layoutState = createLayoutState(node, this.shadowDom);
    layoutState.action = Action.Move;
    this.shadowDom.moveShadowNode(index, layoutState.parent, layoutState.next);
    return layoutState;
  }

  private watch(element: Element, layoutState: IElementLayoutState, styles) {
    // We only wish to watch elements once and then wait on the events to push changes
    if (this.watchList[layoutState.index]) {
      return;
    }

    // Check if scroll is possible, and if so, bind to scroll event
    let scrollPossible = (layoutState.layout !== null
                          && (styles["overflow-x"] === "auto"
                              || styles["overflow-x"] === "scroll"
                              || styles["overflow-y"] === "auto"
                              || styles["overflow-y"] === "scroll"));
    if (scrollPossible) {
      layoutState.layout.scrollX = Math.round(element.scrollLeft);
      layoutState.layout.scrollY = Math.round(element.scrollTop);
      bind(element, "scroll", this.layoutHandler.bind(this, element, Source.Scroll));
      this.watchList[layoutState.index] = true;
    }

    // Check if we need to monitor changes to input fields
    if (element.tagName === "INPUT") {
      bind(element, "change", this.layoutHandler.bind(this, element, Source.Input));
      this.watchList[layoutState.index] = true;
    }
  }

  private layoutHandler(element: Element, source: Source) {
    let index = getNodeIndex(element);
    let recordEvent = true;
    if (index !== null) {
      let time = getTimestamp();
      let lastLayoutState = this.shadowDom.getShadowNode(index).layout;

      // Deep-copy an existing layout JSON
      let newLayoutState: IElementLayoutState = JSON.parse(JSON.stringify(lastLayoutState));
      newLayoutState.source = source;
      newLayoutState.action = Action.Update;

      switch (source) {
        case Source.Scroll:
          newLayoutState.layout.scrollX = Math.round(element.scrollLeft);
          newLayoutState.layout.scrollY = Math.round(element.scrollTop);
          if (lastLayoutState && !this.checkDistance(lastLayoutState as IElementLayoutState, newLayoutState)) {
            recordEvent = false;
          }
          break;
        case Source.Input:
          newLayoutState.attributes.value = element["value"];
          break;
        default:
          break;
      }

      // Update the reference of layouts object to current state
      if (recordEvent) {
        addEvent(this.eventName, newLayoutState);
        this.shadowDom.updateShadowNode(newLayoutState.index, newLayoutState);
      }
    }
  }

  private checkDistance(stateOne: IElementLayoutState, stateTwo: IElementLayoutState) {
    let dx = stateOne.layout.scrollX - stateTwo.layout.scrollX;
    let dy = stateOne.layout.scrollY - stateTwo.layout.scrollY;
    return (dx * dx + dy * dy > this.distanceThreshold * this.distanceThreshold);
  }

  private mutation(mutations: MutationRecord[]) {

    // Don't process mutations on top of the inconsistent state.
    // ShadowDom mutation processing logic requires consistent state as a prerequisite.
    // If we end up in the inconsistent state, that means that something went wrong already,
    // so we can give up on the following mutations and should investigate the cause of the error.
    // Continuing to process mutations can result in javascript errors and lead to even more inconsistencies.
    if (this.shadowDomConsistent) {

      // Perform mutations on the shadow DOM and make sure ShadowDom arrived to the consistent state
      let time = getTimestamp();
      let summary = this.shadowDom.applyMutationBatch(mutations);
      this.ensureConsistency(`Mutation ${this.mutationSequence}`);

      // If node mutates before dom discovery is completed (all initial states are serialized),
      // then store its original properties so that we can reconstruct its initial state later on.
      if (!this.domDiscoverComplete) {
        for (let i = 0; i < mutations.length; i++) {
          this.storeOriginalProperties(mutations[i]);
        }
      }

      if (this.shadowDomConsistent) {
        let events = this.processMutations(summary, time);
        if (this.domDiscoverComplete) {
          for (let i = 0; i < events.length; i++) {
            this.processNodeEvent(events[i]);
          }
        } else {
          this.domPreDiscoverMutations.push(events);
        }
      } else {
        debug(`>>> ShadowDom doesn't match PageDOM after mutation batch #${this.mutationSequence}!`);
      }
    }

    this.mutationSequence++;
  }

  private processMutations(summary: IShadowDomMutationSummary, time: number): ILayoutEventInfo[] {
    let events: ILayoutEventInfo[] = [];

    // Process new nodes
    for (let i = 0; i < summary.newNodes.length; i++) {
      let node = summary.newNodes[i].node;
      events.push({
        node,
        index: getNodeIndex(node),
        source: Source.Mutation,
        action: Action.Insert,
        time
      });
    }

    // Process moves
    for (let i = 0; i < summary.movedNodes.length; i++) {
      let node = summary.movedNodes[i].node;
      events.push({
        node,
        index: getNodeIndex(node),
        source: Source.Mutation,
        action: Action.Move,
        time
      });
    }

    // Process updates
    for (let i = 0; i < summary.updatedNodes.length; i++) {
      let node = summary.updatedNodes[i].node;
      events.push({
        node,
        index: getNodeIndex(node),
        source: Source.Mutation,
        action: Action.Update,
        time
      });
    }

    // Process removes
    for (let i = 0; i < summary.removedNodes.length; i++) {
      let shadowNode = summary.removedNodes[i] as IShadowDomNode;
      events.push({
        node: shadowNode.node,
        index: getNodeIndex(shadowNode.node),
        source: Source.Mutation,
        action: Action.Remove,
        time
      });
      traverseNodeTree(shadowNode, (removedShadowNode: IShadowDomNode) => {
        delete removedShadowNode.node[NodeIndex];
      });
    }

    return events;
  }

  private ensureConsistency(lastAction: string): void {
    let domJson = this.shadowDom.createDomIndexJson();
    this.shadowDomConsistent = this.shadowDom.isConsistent();
    if (this.shadowDomConsistent) {
      this.lastConsistentDomJson = domJson;
    } else {
      let evt: IShadowDomInconsistentEventState = {
        type: Instrumentation.ShadowDomInconsistent,
        dom: JSON.stringify(domJson),
        shadowDom: JSON.stringify(this.shadowDom.createShadowDomIndexJson()),
        lastAction,
        lastConsistentShadowDom: JSON.stringify(this.lastConsistentDomJson)
      };
      instrument(evt);
    }
  }
}
