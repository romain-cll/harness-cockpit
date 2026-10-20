import { runPtyHost } from '@cockpit/pty/host';

// Entry of the utility process: it owns every pseudo-terminal.
runPtyHost(process.parentPort);
