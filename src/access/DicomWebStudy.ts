import { StudyAccess, SeriesAccess } from "../access/DicomAccess";
import { naturalize, logger } from "../utils";
import { JSDOM } from "jsdom";
import { DicomWebSeries } from "./DicomWebSeries";

const jsdomDoc = new JSDOM(``);

global.window = jsdomDoc.window;
// global.window = jsdomDoc.defaultView;
// global.document = window.document;
// global.navigator = window.navigator;
global.XMLHttpRequest = window.XMLHttpRequest;

const log = logger.commandsLog.getLogger("DicomWeb", "Study");

export class DicomWebStudy extends StudyAccess {
  constructor(parent, uid, natural) {
    super(parent, uid, natural);
  }

  public async read() {
    log.warn("Querying dicomweb for study", this.uid);
    const json = await this.dicomAccess.client.searchForStudies({
      queryParams: {
        studyInstanceUID: this.uid,
      },
    });
    log.warn("Read study query result", json?.length);
    if (!json) {
      throw new Error(`No study results found for ${this.uid}`);
    }
    this.jsonData = json;
    this.natural = naturalize(json);
  }

  public createAccess(sopUID: string, natural) {
    log.debug("Creating access on sopUID", sopUID);
    return new DicomWebSeries(this, sopUID, natural);
  }

  public async queryChildren(): Promise<SeriesAccess[]> {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    log.info("About to query for series in study", this.uid);
    const json = await this.dicomAccess.client.searchForSeries({
      studyInstanceUID: this.uid,
    });
    const naturalJson = naturalize(json);
    log.debug("Found series count=", naturalJson.length);
    return naturalJson.map((series) => this.addJson(series));
  }
}
