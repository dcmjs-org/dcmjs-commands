export function getValue(item, tag) {
  const value = item[tag];
  // dcmjs 1.0 gives an empty element no Value
  if (!value?.Value) return undefined;
  if (value.Value.length == 1) return value.Value[0];
  return value.Value.length === 0 ? "" : value.Value;
}
