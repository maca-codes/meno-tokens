// Prints where /meno:handoff must write the note for the current folder.
'use strict';
process.stdout.write(require('./lib').handoffFile(process.cwd()));
