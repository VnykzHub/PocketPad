/** Required host-shell element lookup; a missing shell fails loudly at boot. */
export function element(doc: Document, id: string): HTMLElement {
  const found = doc.getElementById(id);
  if (found === null) {
    throw new Error(`Host shell is missing #${id}.`);
  }
  return found;
}
