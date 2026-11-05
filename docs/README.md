# Documentation

- [specs/](specs/) holds the specifications. Each specification has a `§ User requirements`
  section and a `§ Implementation requirements` section, with their own identifiers and
  change rules.
  - [specs/cli/](specs/cli/) covers the commands of the executables.
    - [transcode-and-wsiresize.md](specs/cli/transcode-and-wsiresize.md): `dcmjs transcode`
      and `dcmjs wsiresize` (`TC-*`, `WR-*`, `PX-I*`).
  - [specs/library/](specs/library/) covers the library exports.
    - [pixel.md](specs/library/pixel.md): `@dcmjs/commands/pixel` and
      `selectTargetSyntax` (`PL-*`).
