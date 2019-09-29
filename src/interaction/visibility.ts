import { Event } from "@clarity-types/data";
import { IVisibileData } from "@clarity-types/interaction";
import { bind } from "@src/core/event";
import encode from "./encode";

export let data: IVisibileData;

export function start(): void {
    bind(document, "visibilitychange", recompute);
    recompute();
}

function recompute(): void {
    data = { visible: "visibilityState" in document ? document.visibilityState : "default" };
    encode(Event.Visibility);
}

export function reset(): void {
    data = null;
}
