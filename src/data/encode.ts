import {Event, Token } from "@clarity-types/data";
import { Metric } from "@clarity-types/metric";
import time from "@src/core/time";
import { metadata } from "@src/data/metadata";
import * as ping from "@src/data/ping";
import * as tag from "@src/data/tag";
import * as metric from "@src/metric";
import { queue } from "./upload";

export default function(event: Event): void {
    let t = time();
    let tokens: Token[] = [t, event];
    switch (event) {
        case Event.Ping:
            tokens.push(ping.data.gap);
            queue(tokens);
            break;
        case Event.Page:
            metric.counter(Metric.StartTime, Math.round(performance.now()));
            tokens.push(metadata.page.timestamp);
            tokens.push(metadata.page.elapsed);
            tokens.push(metadata.page.url);
            tokens.push(metadata.page.title);
            tokens.push(metadata.page.referrer);
            queue(tokens);
            break;
        case Event.Tag:
            tokens.push(tag.data.key);
            tokens.push(tag.data.value);
            queue(tokens);
            break;
    }
}
