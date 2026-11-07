// The wisp-native binary, when one is found (WISP_NATIVE_BIN, the platform package, or a release
// build in native/target/release). `npm run test:native` builds it first and runs these.

import { defaultLocateDeps, locateBinary } from '../src/locate.ts';
import { startNative } from '../src/index.ts';
import { contract } from './contract.ts';

const found = locateBinary(defaultLocateDeps(process.env));
const skip = found.binary === null && `wisp-native not built (${found.reason}); run \`npm run test:native\` to build and test it`;

contract({ name: 'wisp-native', start: () => startNative({ prefer: 'native' }), skip, resizable: true });
