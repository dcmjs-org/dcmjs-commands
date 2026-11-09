# Specification: `dimsejs` (user requirements)

## Scope

This specification covers the DIMSE SCU commands of the `dimsejs` executable: `echo`, `find`,
`store` and `get`. It states what the user must be able to do, or must be able to know, to use
the commands safely.

Change a user requirement only when the requirement describes the behaviour incorrectly, or
when the intended user-facing behaviour changes. A more convenient implementation is never a
reason to change a user requirement. The implementation requirements are in
[dimsejs-implementation.md](dimsejs-implementation.md).

## User requirements

- **DM-U1.** The user can check the connection to an SCP with `dimsejs echo`. The command
  exits with 0 only when the SCP answers the C-ECHO with Success.
- **DM-U2.** The user can query an SCP at the study, series, image or worklist level with
  `dimsejs find`. The command prints the matches as a JSON array of DICOM JSON objects, the
  same form as a QIDO-RS response. The user gives each query key as `-k Keyword=value`.
- **DM-U3.** `dimsejs find` refuses an unknown keyword before it connects to the SCP.
- **DM-U4.** The user can send Part 10 files and directories of Part 10 files with
  `dimsejs store`.
- **DM-U5.** `dimsejs store` sends the data of each file without a change when the SCP
  accepts the transfer syntax of the file. When the SCP accepts only a different transfer
  syntax, the command converts the data. The SOPInstanceUID does not change in either case.
- **DM-U6.** `dimsejs store` reports each file that fails, and the number of instances that
  it stored.
- **DM-U7.** The user can retrieve a study, a series or an instance with `dimsejs get`. The
  command writes one Part 10 file for each retrieved instance, with the name
  `<SOPInstanceUID>.dcm`, in the directory that `-d` gives.
- **DM-U8.** Every command exits with 0 on success, with 1 on a failure status, a network
  error or an association rejection, and with 2 on a usage error. A message on stderr names
  the command and the cause.
- **DM-U9.** The user can set the calling AE title (`--aet`), the called AE title (`--aec`)
  and the timeout (`--timeout`) for every command.
