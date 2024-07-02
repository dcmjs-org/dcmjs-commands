#!/usr/bin/env node
import { Command } from 'commander';
import { dicomweb, instanceDicom, dumpDicom } from '../src/index.js';

const program = new Command();

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