import dcmjs from "dcmjs";

const { DicomMetaDictionary } = dcmjs.data;


/**
 * Looks up the best VR it can find given the data/configuration for
 * the given tag.
 *  
 */

const nullVrTags = new Set();
nullVrTags.add("FFFEE00D");

export function getVr(tag, data) {
  // lookup the vr using the data dictionary
  var punctuatedTag = DicomMetaDictionary.punctuateTag(tag);
  var entry = DicomMetaDictionary.dictionary[punctuatedTag];
  if( entry?.vr) {
    return entry.vr;
  }
  const { Value } = data;
  if( Value?.[0] ) {
    const [first] = Value;
    if( typeof first === "number" ) {
        return "FL";
    }
    return "UT";
  }
  return "UN";
};

export default getVr;
