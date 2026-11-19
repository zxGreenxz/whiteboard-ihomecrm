import { CameraClientError } from "./errors.js";

/**
 * One element of a recorder reply. Namespaces are not modelled: a name is the
 * lower-cased part after any prefix, so `<ns:HDD xmlns:ns="...">` and `<hdd>`
 * read the same whatever schema URL a firmware declares.
 */
export interface XmlElement {
  name: string;
  /** Character data directly inside this element, entities decoded, children excluded. */
  text: string;
  children: XmlElement[];
}

const MAX_ELEMENTS = 20_000;
const MAX_DEPTH = 32;
const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const invalid = () => new CameraClientError("INVALID_RESPONSE");
const localName = (raw: string) => raw.slice(raw.indexOf(":") + 1).toLowerCase();

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/gu, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Read a small, well-formed document into a tree. Attributes, comments and
 * processing instructions are skipped. A DOCTYPE is refused outright, so no
 * entity is ever expanded beyond the five predefined ones and character
 * references. Unbalanced or oversized input is INVALID_RESPONSE.
 */
export function parseXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const holder: XmlElement = { name: "", text: "", children: [] };
  const stack: Array<{ element: XmlElement; raw: string }> = [{ element: holder, raw: "" }];
  let elements = 0;
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    const top = stack[stack.length - 1]!.element;
    if (open < 0) {
      if (text.slice(index).trim() !== "") throw invalid();
      break;
    }
    if (open > index) {
      const data = text.slice(index, open);
      if (stack.length > 1) top.text += decodeEntities(data);
      else if (data.trim() !== "") throw invalid();
    }
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end < 0) throw invalid();
      index = end + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (end < 0 || stack.length === 1) throw invalid();
      top.text += text.slice(open + 9, end);
      index = end + 3;
    } else if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end < 0) throw invalid();
      index = end + 2;
    } else if (text.startsWith("<!", open)) {
      throw invalid();
    } else if (text.startsWith("</", open)) {
      const end = text.indexOf(">", open + 2);
      if (end < 0 || stack.length === 1) throw invalid();
      if (text.slice(open + 2, end).trim() !== stack[stack.length - 1]!.raw) throw invalid();
      stack.pop();
      index = end + 1;
    } else {
      // Find the end of the tag without being fooled by `>` inside an attribute value.
      let end = open + 1;
      let quote = "";
      for (; end < text.length; end += 1) {
        const char = text[end]!;
        if (quote) { if (char === quote) quote = ""; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }
      if (end >= text.length) throw invalid();
      const selfClosing = text[end - 1] === "/";
      const raw = /^[^\s/>]+/u.exec(text.slice(open + 1, end))?.[0];
      if (!raw || !/^[A-Za-z_][\w.:-]*$/u.test(raw)) throw invalid();
      if (stack.length === 1 && holder.children.length > 0) throw invalid();
      elements += 1;
      if (elements > MAX_ELEMENTS || stack.length > MAX_DEPTH) throw invalid();
      const element: XmlElement = { name: localName(raw), text: "", children: [] };
      top.children.push(element);
      if (!selfClosing) stack.push({ element, raw });
      index = end + 1;
    }
  }
  const root = holder.children[0];
  if (stack.length !== 1 || !root) throw invalid();
  return root;
}

/** Direct children with this local name, case-insensitively. */
export function childrenNamed(parent: XmlElement, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  return parent.children.filter((child) => child.name === wanted);
}

/** Trimmed text of the first direct child with this name; undefined when the child is absent. */
export function childText(parent: XmlElement, name: string): string | undefined {
  return childrenNamed(parent, name)[0]?.text.trim();
}
