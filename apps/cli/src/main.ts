import { runCli } from '@cockpit/daemon/cli';

await runCli(process.argv.slice(2), process.env, {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
});
