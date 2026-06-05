// Tiny DOM construction helpers shared by every component. No framework:
// el() builds real elements, children are appended, strings become text
// nodes (XSS-safe by default — innerHTML only via the explicit `html` key).

let uidCounter = 0;

/** Unique id for SVG defs / aria wiring. Stable within a page session. */
export function uid(prefix = "c") {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(36)}`;
}

/**
 * el("button", { class: "btn", dataset: {evidence: id}, onclick: fn,
 *                aria: {label: "Close"}, attrs... }, ...children)
 * Children: Node | string | number | null/undefined/false (skipped) | array.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Same as el() but in the SVG namespace. */
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs, true);
  append(node, children);
  return node;
}

function applyAttrs(node, attrs, isSvg = false) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      node.setAttribute("class", value);
    } else if (key === "dataset") {
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && v !== undefined) node.dataset[k] = v;
      }
    } else if (key === "aria") {
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && v !== undefined) node.setAttribute(`aria-${k}`, v);
      }
    } else if (key === "style" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    } else if (key === "html") {
      node.innerHTML = value; // explicit opt-in only
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (!isSvg && key in node && typeof node[key] !== "object" && key !== "list") {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

/** Document fragment from children. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Remove all children. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
