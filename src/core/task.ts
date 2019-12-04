import { AsyncTask, RequestIdleCallbackDeadline, RequestIdleCallbackOptions } from "@clarity-types/core";
import { TaskFunction, TaskResolve, TaskTracker } from "@clarity-types/core";
import { Metric } from "@clarity-types/data";
import config from "@src/core/config";
import * as metric from "@src/data/metric";

// Track the start time to be able to compute duration at the end of the task
const idleTimeout = 5000;
let tracker: TaskTracker = {};
let queue: AsyncTask[] = [];
let active: AsyncTask = null;

export function reset(): void {
    tracker = {};
    queue = [];
    active = null;
}

export async function schedule(task: TaskFunction): Promise<void> {
    // If this task is already scheduled, skip it
    for (let q of queue) {
        if (q.task === task) {
            return;
        }
    }

    let promise = new Promise<void>((resolve: TaskResolve): void => {
        queue.push({task, resolve});
    });

    // If there is no active task running, invoke the first task in the queue synchronously
    // This also ensures we don't yield the thread during unload event
    if (active === null) { run(); }

    return promise;
}

function run(): void {
    let entry = queue.shift();
    if (entry) {
        active = entry;
        entry.task().then(() => {
            entry.resolve();
            active = null; // Reset active task back to null now that the promise is resolved
            run();
        });
    }
}

export function shouldYield(method: Metric): boolean {
    let elapsed = performance.now() - tracker[method].start;
    return (elapsed > tracker[method].yield);
}

export function start(method: Metric): void {
    tracker[method] = { start: performance.now(), calls: 0, yield: config.longtask };
}

function resume(method: Metric): void {
    let c = tracker[method].calls;
    start(method);
    tracker[method].calls = c + 1;
}

export function stop(method: Metric): void {
    let end = performance.now();
    let duration = end - tracker[method].start;
    metric.accumulate(method, duration);
    metric.count(Metric.InvokeCount);

    // For the first execution, which is synchronous, time is automatically counted towards TotalDuration.
    // However, for subsequent asynchronous runs, we need to manually update TotalDuration metric.
    if (tracker[method].calls > 0) { metric.accumulate(Metric.TotalDuration, duration); }
}

export async function pause(method: Metric): Promise<void> {
    // Pause and yield the thread only if the task is still being tracked
    // It's possible that Clarity is wrapping up instrumentation on a page and we are still in the middle of an async task.
    // In that case, we do not wish to continue yielding thread.
    // Instead, we will turn async task into a sync task and maximize our chances of getting some data back.
    if (method in tracker) {
        stop(method);
        tracker[method].yield = (await wait()).timeRemaining();
        resume(method);
    }
}

async function wait(): Promise<RequestIdleCallbackDeadline> {
    return new Promise<RequestIdleCallbackDeadline>((resolve: (deadline: RequestIdleCallbackDeadline) => void): void => {
        requestIdleCallback(resolve, { timeout: idleTimeout });
    });
}

// Use native implementation of requestIdleCallback if it exists.
// Otherwise, fall back to a custom implementation using requestAnimationFrame & MessageChannel.
// While it's not possible to build a perfect polyfill given the nature of this API, the following code attempts to get close.
// Background context: requestAnimationFrame invokes the js code right before: style, layout and paint computation within the frame.
// This means, that any code that runs as part of requestAnimationFrame will by default be blocking in nature. Not what we want.
// For non-blocking behavior, We need to know when browser has finished painiting. This can be accomplished in two different ways (hacks):
//   (1) Use MessageChannel to pass the message, and browser will receive the message right after pain event has occured.
//   (2) Use setTimeout call within requestAnimationFrame. This also works, but there's a risk that browser may throttle setTimeout calls.
// Given this information, we are currently using (1) from above. More information on (2) as well as some additional context is below:
// https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Performance_best_practices_for_Firefox_fe_engineers
let requestIdleCallback = window["requestIdleCallback"] ||
function(callback: (deadline: RequestIdleCallbackDeadline) => void, options: RequestIdleCallbackOptions): void {
    const startTime = performance.now();
    const channel = new MessageChannel();
    const incoming = channel.port1;
    const outgoing = channel.port2;
    incoming.onmessage = (event: MessageEvent): void => {
        let currentTime = performance.now();
        let elapsed = currentTime - startTime;
        let duration = currentTime - event.data;
        if (duration > config.longtask && elapsed < options.timeout) {
            requestAnimationFrame(() => { outgoing.postMessage(currentTime); });
        } else {
            let didTimeout = elapsed > options.timeout;
            callback({
                didTimeout,
                timeRemaining: (): number => didTimeout ? config.longtask : Math.max(0, config.longtask - duration)
            });
        }
    };
    requestAnimationFrame(() => { outgoing.postMessage(performance.now()); });
};
