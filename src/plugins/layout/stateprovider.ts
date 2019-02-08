import {
  IAttributes, IDoctypeLayoutState, IElementLayoutState, IIgnoreLayoutState,
  ILayoutRectangle, ILayoutState, IStyleLayoutState, ITextLayoutState
} from "@clarity-types/layout";
import { config } from "@src/config";
import { mask } from "@src/utils";

export const NodeIndex = "clarity-index";

export enum Tags {
  Meta = "META",
  Script = "SCRIPT",
  Doc = "*DOC*",
  Text = "*TXT*",
  Ignore = "*IGNORE*"
}

enum Styles {
  Color = "color",
  BackgroundColor = "backgroundColor",
  BackgroundImage = "backgroundImage",
  OverflowX = "overflowX",
  OverflowY = "overflowY",
  Visibility = "visibility"
}

const DefaultAttributeMaskList = ["value", "placeholder", "alt", "title"];

let defaultColor: string;
let attributeMaskList: string[];

export function resetStateProvider() {
  attributeMaskList = DefaultAttributeMaskList.concat(config.sensitiveAttributes);
  defaultColor = "";
}

export function getNodeIndex(node: Node): number {
  return (node && NodeIndex in node) ? node[NodeIndex] : null;
}

export function createLayoutState(node: Node, ignore: boolean, forceMask: boolean): ILayoutState {
  let state: ILayoutState = null;
  if (ignore) {
    state = createIgnoreLayoutState(node);
  } else {
    switch (node.nodeType) {
      case Node.DOCUMENT_TYPE_NODE:
        state = createDoctypeLayoutState(node as DocumentType);
        break;
      case Node.TEXT_NODE:
        state = createTextLayoutState(node as Text, forceMask);
        break;
      case Node.ELEMENT_NODE:
        let elem = node as Element;
        if (elem.tagName === "STYLE") {
          state = createStyleLayoutState(elem as HTMLStyleElement, forceMask);
        } else {
          state = createElementLayoutState(elem, forceMask);
        }
        break;
      default:
        state = createIgnoreLayoutState(node);
        break;
    }
  }
  return state;
}

export function createDoctypeLayoutState(doctypeNode: DocumentType): IDoctypeLayoutState {
  let doctypeState = createGenericLayoutState(doctypeNode, Tags.Doc) as IDoctypeLayoutState;
  doctypeState.attributes = {
    name: doctypeNode.name,
    publicId: doctypeNode.publicId,
    systemId: doctypeNode.systemId
  };
  return doctypeState;
}

export function createElementLayoutState(element: Element, forceMask: boolean): IElementLayoutState {
  let tagName = element.tagName;
  let elementState = createGenericLayoutState(element, tagName) as IElementLayoutState;
  if (tagName === Tags.Script || tagName === Tags.Meta) {
    elementState.tag = Tags.Ignore;
    return elementState;
  }

  // Get attributes for the element
  elementState.attributes = getAttributes(element, forceMask);

  // Get layout bounding box for the element
  elementState.layout = getLayout(element);

  // Get computed systems for the element with valid layout
  elementState.style = elementState.layout ? getStyles(element) : null;

  // Check if scroll is possible
  if (elementState.layout && elementState.style && (Styles.OverflowX in elementState.style || Styles.OverflowX in elementState.style)) {
    elementState.layout.scrollX = Math.round(element.scrollLeft);
    elementState.layout.scrollY = Math.round(element.scrollTop);
  }

  return elementState;
}

export function createStyleLayoutState(styleNode: HTMLStyleElement, forceMask: boolean): IStyleLayoutState {
  let layoutState = createElementLayoutState(styleNode, forceMask) as IStyleLayoutState;
  if (styleNode.textContent.length === 0) {
    layoutState.cssRules = getCssRules(styleNode);
  }
  return layoutState;
}

export function getCssRules(element: HTMLStyleElement) {
  let cssRules = null;

  let rules = [];
  // Firefox throws a SecurityError when trying to access cssRules of a stylesheet from a different domain
  try {
    let sheet = element.sheet as CSSStyleSheet;
    cssRules = sheet ? sheet.cssRules : [];
  } catch (e) {
    if (e.name !== "SecurityError") {
      throw e;
    }
  }

  if (cssRules !== null) {
    rules = [];
    for (let i = 0; i < cssRules.length; i++) {
      rules.push(cssRules[i].cssText);
    }
  }

  return rules;
}

export function createTextLayoutState(textNode: Text, forceMask: boolean): ITextLayoutState {
  // Text nodes that are children of the STYLE elements contain CSS code, so we don't want to hide it
  // Checking parentNode, instead of parentElement, because in IE textNode.parentElement returns 'undefined'.
  let parent = textNode.parentNode;
  let isCss = parent && parent.nodeType === Node.ELEMENT_NODE && (parent as Element).tagName === "STYLE";
  let isLink = parent && parent.nodeType === Node.ELEMENT_NODE && (parent as Element).tagName === "A";
  let showText = (isLink ? config.showLinks : config.showText) && !forceMask;
  let textState = createGenericLayoutState(textNode, Tags.Text) as ITextLayoutState;
  textState.content = isCss || showText ? textNode.nodeValue : mask(textNode.nodeValue);
  return textState;
}

export function createIgnoreLayoutState(node: Node): IIgnoreLayoutState {
  let layoutState = createGenericLayoutState(node, Tags.Ignore) as IIgnoreLayoutState;
  layoutState.nodeType = node.nodeType;
  if (node.nodeType === Node.ELEMENT_NODE) {
    layoutState.elementTag = (node as Element).tagName;
  }
  return layoutState;
}

export function createGenericLayoutState(node: Node, tag: string): ILayoutState {
  let layoutIndex = getNodeIndex(node);
  let state: ILayoutState = {
    index: layoutIndex,
    parent: getNodeIndex(node.parentNode),
    previous: getNodeIndex(node.previousSibling),
    next: getNodeIndex(node.nextSibling),
    source: null,
    action: null,
    tag
  };
  return state;
}

function getLayout(element): ILayoutRectangle {
  let layout: ILayoutRectangle = null;
  // In IE, calling getBoundingClientRect on a node that is disconnected
  // from a DOM tree, sometimes results in a 'Unspecified Error'
  // Wrapping this in try/catch is faster than checking whether element is connected to DOM
  let rect = null;
  let doc = document.documentElement;
  try {
    rect = element.getBoundingClientRect();
  } catch (e) {
    // Ignore
  }

  if (rect) {
    // getBoundingClientRect returns relative positioning to viewport and therefore needs
    // addition of window scroll position to get position relative to document
    // Also: using Math.floor() instead of Math.round() below because in Edge,
    // getBoundingClientRect returns partial pixel values (e.g. 162.5px) and Chrome already
    // floors the value (e.g. 162px). Keeping behavior consistent across
    layout = {
      x: Math.floor(rect.left) + ("pageXOffset" in window ? window.pageXOffset : doc.scrollLeft),
      y: Math.floor(rect.top) + ("pageYOffset" in window ? window.pageYOffset : doc.scrollTop),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  return layout;
}

function getAttributes(element: Element, forceMask: boolean): IAttributes {
  let elementAttributes = element.attributes;
  let tagName = element.tagName;
  let stateAttributes: IAttributes = {};

  for (let i = 0; i < elementAttributes.length; i++) {
    let attr = elementAttributes[i];
    let attrName = attr.name.toLowerCase();

    // If it's an image and configuration disallows capturing images then skip src attribute
    const skipAttribute = (!config.showImages || forceMask) && tagName === "IMG" && attrName === "src";
    if (skipAttribute) { continue; }

    // If we are masking text, also mask it from input boxes as well as alt description
    let showAttribute = config.showText && !forceMask
                        ? true
                        : attributeMaskList.indexOf(attrName) < 0;
    stateAttributes[attr.name] = showAttribute ? attr.value : mask(attr.value);
  }

  return stateAttributes;
}

function getStyles(element) {
  let computed = window.getComputedStyle(element);
  let style = {};

  if (defaultColor.length === 0) {
    defaultColor = computed[Styles.Color];
  }

  // Send computed styles, if relevant, back to server
  if (match(computed[Styles.Visibility], ["hidden", "collapse"])) {
    style[Styles.Visibility] = computed[Styles.Visibility];
  }

  if (match(computed[Styles.OverflowX], ["auto", "scroll", "hidden"])) {
    style[Styles.OverflowX] = computed[Styles.OverflowX];
  }

  if (match(computed[Styles.OverflowY], ["auto", "scroll", "hidden"])) {
    style[Styles.OverflowY] = computed[Styles.OverflowY];
  }

  if (computed[Styles.BackgroundImage] !== "none") {
    style[Styles.BackgroundImage] = computed[Styles.BackgroundImage];
  }

  if (!match(computed[Styles.BackgroundColor], ["rgba(0, 0, 0, 0)", "transparent"])) {
    style[Styles.BackgroundColor] = computed[Styles.BackgroundColor];
  }

  if (computed[Styles.Color] !== defaultColor) {
    style[Styles.Color] = computed[Styles.Color];
  }

  return Object.keys(style).length > 0 ? style : null;
}

function match(variable: string, values: string[]): boolean {
  return values.indexOf(variable) > -1;
}
