// tsx currently calls os.userInfo() while registering its loader. In this
// restricted Windows environment that OS lookup can fail before tests start.
const os = require("node:os");
os.userInfo = () => ({ username: "scheduler-test" });
require("node:module").syncBuiltinESMExports();
require("tsx/cjs");
