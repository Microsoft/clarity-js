import { DecodedToken, Event, IDecodedEvent, IEvent, IPayload } from "../types/data";
import { IDecodedNode } from "../types/dom";
import dom from "./dom";
import metrics from "./metrics";

let nodes = {};
let pageId: string = null;
let payloads: IPayload[] = [];

export function json(payload: IPayload): IDecodedEvent[] {
    if (pageId !== payload.p) {
        payloads = [];
        nodes = {};
        pageId = payload.p;
    }

    let decoded: IDecodedEvent[] = [];
    let encoded: IEvent[] = JSON.parse(payload.d);
    payloads.push(payload);
    let count = 0;
    for (let entry of encoded) {
        let exploded = { time: entry.t, event: entry.e, data: entry.d as DecodedToken[] };
        count++;
        switch (entry.e) {
            case Event.Discover:
            case Event.Mutation:
                console.warn("!Event: " + (entry.e === Event.Mutation ? "Mutation" : "Discover") +
                " | Payload #" + payload.n + " | Event #" + count + " | Nodes #" + entry.d.length +
                " | First Id: " + (entry.d.length > 0 ? entry.d[0] : -1) + " | Events: " + JSON.stringify(entry.d));
                exploded.data = dom(entry.d);
                break;
            case Event.Metrics:
                exploded.data = metrics(entry.d);
                break;
        }
        decoded.push(exploded);
    }
    return decoded;
}

export function html(payload: IPayload): string {
    let placeholder = document.createElement("iframe");
    render(payload, placeholder);
    return placeholder.contentDocument.documentElement.outerHTML;
}

export function render(payload: IPayload, placeholder: HTMLIFrameElement): void {
    let decoded = json(payload);
    for (let entry of decoded) {
        switch (entry.event) {
            case Event.Discover:
            case Event.Mutation:
                markup(entry.data, placeholder);
                break;
        }
    }
}

function markup(data: IDecodedNode[], placeholder: HTMLIFrameElement): void {
    let doc = placeholder.contentDocument;
    for (let node of data) {
        console.log("Markup Node: " + JSON.stringify(node));
        let parent = element(node.parent);
        let next = element(node.next);
        switch (node.tag) {
            case "*D":
                if (typeof XMLSerializer !== "undefined" && false) {
                    doc.open();
                    doc.write(new XMLSerializer().serializeToString(
                        doc.implementation.createDocumentType(
                            node.attributes["name"],
                            node.attributes["publicId"],
                            node.attributes["systemId"]
                        )
                    ));
                    doc.close();
                }
                break;
            case "*T":
                let textElement = element(node.id);
                textElement = textElement ? textElement : doc.createTextNode(null);
                textElement.nodeValue = node.value;
                insert(node.id, parent, textElement, next);
                break;
            case "HTML":
                let newDoc = doc.implementation.createHTMLDocument("");
                let docElement = newDoc.documentElement;
                let pointer = doc.importNode(docElement, true);
                doc.replaceChild(pointer, doc.documentElement);
                if (doc.head) { doc.head.parentNode.removeChild(doc.head); }
                if (doc.body) { doc.body.parentNode.removeChild(doc.body); }
                nodes[node.id] = doc.documentElement;
                break;
            default:
                let domElement = element(node.id);
                domElement = domElement ? domElement : doc.createElement(node.tag);
                if (!node.attributes) { node.attributes = {}; }
                node.attributes["data-id"] = `${node.id}`;
                setAttributes(domElement as HTMLElement, node.attributes);
                insert(node.id, parent, domElement, next);
                break;
        }
    }
}

function element(nodeId: number): Node {
    return nodeId !== null && nodeId > 0 && nodeId in nodes ? nodes[nodeId] : null;
}

function insert(id: number, parent: Node, node: Node, next: Node): void {
    if (parent !== null) { parent.insertBefore(node, next); }
    nodes[id] = node;
}

function setAttributes(node: HTMLElement, attributes: object): void {
    for (let attribute in node.attributes) {
        if (node.hasAttribute(attribute)) {
            node.removeAttribute(attribute);
        }
    }
    for (let attribute in attributes) {
        if (attributes[attribute]) {
            node.setAttribute(attribute, attributes[attribute]);
        }
    }
}