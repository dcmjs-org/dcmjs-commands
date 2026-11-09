export function fixValue(value) {
  if (!value?.Value) {
    return;
  }
  if (
    value.vr === "CS" &&
    value.Value.length === 1 &&
    typeof value.Value[0] === "string"
  ) {
    value.Value = value.Value[0].split("\\");
  }
}
