export interface IPointer {
    target: number;
    x: number;
    y: number;
    targetX?: number;
    targetY?: number;
    time?: number;
}

export interface IResize {
    width: number;
    height: number;
}

export interface IScroll {
    target: number;
    x: number;
    y: number;
    time?: number;
}

export interface IVisibility {
    visible: string;
}

export interface ISelection {
    start: number;
    startOffset: number;
    end: number;
    endOffset: number;
}

export interface IChange {
    target: number;
    value: string;
}

export interface IUnload {
    name: string;
}
