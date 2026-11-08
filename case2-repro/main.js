// The only SDK call in this reproduction: construct the client with placeholder
// credentials. The point is the emitted bundle, not the runtime config.
import { GameAlgoWebClient } from '@gamealgo/web';

window.client = new GameAlgoWebClient({
  baseUrl: 'http://127.0.0.1:5277/api',
  gameKey: 'repro',
  appVersion: '0.0.0-repro',
});
