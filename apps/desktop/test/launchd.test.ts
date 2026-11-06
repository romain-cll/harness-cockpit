import { describeMode } from './support/mode-checks';
import { describePanesLaunchdSmoke } from './support/panes';
import { describeResumeSmoke, launchPackagedWith, PACKAGED_CLI } from './support/sessions';
import { LAUNCHD_ENV, launchLaunchd } from './support/terminal';

describeMode('packaged app with the launchd environment', launchLaunchd);

describePanesLaunchdSmoke();

// COCKPIT-30: the packaged app with launchd's minimal environment, on a fake login shell (the one that holds the stub
// `claude`): the hooks name the CLI by its absolute path, so nothing needs the PATH launchd does not give.
describeResumeSmoke('packaged app with the launchd environment', (fx) => launchPackagedWith({ ...LAUNCHD_ENV, SHELL: fx.shell }), PACKAGED_CLI);
