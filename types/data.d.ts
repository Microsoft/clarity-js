import { IDecodedMetric } from "./metric";

export type Token = (string | number | number[] | string[]);
export type DecodedToken = (any | any[]);

export const enum Event {
    Metadata,
    Discover,
    Mutation,
    Mouse,
    Touch,
    Keyboard,
    Selection,
    Resize,
    Scroll,
    Document,
    Visibility,
    Network,
    Performance,
    ScriptError,
    ImageError
}

export const enum Flush {
    Schedule,
    Force,
    None
}

export interface IEventQueue {
    server: IEvent[];
    client: IEvent[];
}

export interface IEvent {
    t: number;
    e: Event;
    d: Token[];
}

export interface IPayload {
    e: Token[];
    m: Token[];
    s: IEvent[];
    c: IEvent[];
}

export interface IDecodedPayload {
    envelope: IEnvelope;
    metrics: IDecodedMetric;
    data: IDecodedEvent[];
}

export interface IDecodedEvent {
    time: number;
    event: Event;
    data: any;
}

export interface IEnvelope {
    sequence: number;
    version: string;
    pageId: string;
    userId: string;
    projectId: string;
}

export interface IMetadata extends IEnvelope {
    url: string;
    title: string;
}
