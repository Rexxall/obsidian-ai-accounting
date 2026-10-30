import { config } from './eslint.config.mjs';

// The directory scanner does not install devDependencies, so moment's and Node's types are missing there.
// This pass maps them to an untyped module so every unsafe use shows up locally as well.
export default config('./tsconfig.scorecard.json');
