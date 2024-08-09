#!/usr/bin/env node
import { Command } from 'commander';
import { dicomweb, instanceDicom, dumpDicom } from '../src/index.js';

const program = new Command();

program.option('-s, --study <studyInstanceUID>', 'Download a specific study instance UID');

program
  .name('dicomwebjs')
  .description('dicomwebjs based tools for manipulation of DICOMweb')
  .version('0.0.1')
  .option('--seriesUID <seriesUID>', 'For a specific seriesUID');

program.command('dump')
  .description('Dump a dicomweb file')
  .argument('<dicomwebUrl>', 'dicomweb URL or file location')
  .action(async (fileName, options) => {
    const qido = await dicomweb.readDicomWeb(fileName, options);
    for (const dict of qido) {
      dumpDicom({ dict });
    }
  });

program.command('download')
  .description('Download dicomweb file(s)')
  .argument('<dicomwebUrl>', 'dicomweb URL to the base DICOMweb service')
  .option('-d, --directory <dicomwebdir>', 'Download to local DICOMweb directory')
  .action(async (fileName, options) => {
    let downloadUrls = [fileName];
    if (options.study) {
      downloadUrls = await dicomweb.queryDownloads(fileName, options);
    }
    for (const downloadUrl of downloadUrls) {
      const data = await dicomweb.readDicomWeb(downloadUrl, options);
      dicomweb.store(downloadUrl, data, options);
    }
  });

program.command('instance')
  .description('Write the instance data')
  .argument('<part10>', 'part 10 file')
  .option('-p, --pretty', 'Pretty print')
  .action(async (fileName, options) => {
    const qido = await dicomweb.readDicomWeb(fileName, options);
    for (const dict of qido) {
      instanceDicom({ dict }, options);
    }
  })


program.parse();