const fs = require("fs");
const path = require("path");

const artifact = path.join(__dirname, "..", "dist", "main.js");
if (fs.existsSync(artifact) && fs.statSync(artifact).size > 0) {
  console.log("OK: build artifact present:", artifact);
  process.exit(0);
} else {
  console.error("FAIL: build artifact missing or empty:", artifact);
  process.exit(2);
}
