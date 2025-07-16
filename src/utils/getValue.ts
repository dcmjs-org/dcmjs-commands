export function getValue(item, tag) {
    const value = item[tag];
    if (!value) return undefined;
    if (value.Value) {
      if (value.Value.length == 1) return value.Value[0];
      return value.Value.length === 0 ? "" : value.Value;
    }
    return value;
}
