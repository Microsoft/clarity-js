import { Event } from "@clarity-types/data";
import { IDocumentData } from "@clarity-types/layout";
import encode from "./encode";

export let data: IDocumentData;

export function reset(): void {
    data = null;
}

export function compute(): void {
    let body = document.body;
    let d = document.documentElement;
    let width = body ? body.clientWidth : null;
    let bodyClientHeight = body ? body.clientHeight : null;
    let bodyScrollHeight = body ? body.scrollHeight : null;
    let bodyOffsetHeight = body ? body.offsetHeight : null;
    let documentClientHeight = d ? d.clientHeight : null;
    let documentScrollHeight = d ? d.scrollHeight : null;
    let documentOffsetHeight = d ? d.offsetHeight : null;
    let height = Math.max(bodyClientHeight, bodyScrollHeight, bodyOffsetHeight,
    documentClientHeight, documentScrollHeight, documentOffsetHeight);

    if (data === null || width !== data.width || height !== data.height) {
        data = { width, height };
        encode(Event.Document);
    }
}
