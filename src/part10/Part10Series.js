// src/part10/Part10Series.js

import { SeriesAccess } from "../access/DicomAccess.js";
import { Part10Instance } from "./Part10Instance.js";

export class Part10Series extends SeriesAccess {
  createAccess(sopUID, natural) {
    return new Part10Instance(this, sopUID, natural);
  }

  async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const children = [];
    for (const entry of this.instanceEntries.values()) {
      const instance = this.addJson(entry.natural);
      instance.jsonData = entry.jsonData;
      instance.entry = entry;
      children.push(instance);
    }
    return children;
  }
}
