import { describeMode } from './support/mode-checks';
import { describePanesLaunchdSmoke } from './support/panes';
import { launchLaunchd } from './support/terminal';

describeMode('packaged app with the launchd environment', launchLaunchd);

describePanesLaunchdSmoke();
