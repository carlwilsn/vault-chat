const fs = require('fs');
const s = fs.readFileSync('C:/Users/wada2/github/vault-chat/src/store.ts','utf8');
const lines = s.split('\n');
for (let i = 174; i < 180; i++) {
  console.log(i + ': ' + JSON.stringify(lines[i]));
}
