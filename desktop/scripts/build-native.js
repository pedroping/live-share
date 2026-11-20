// Compiles native/AppAudio.cs with the C# compiler that ships with Windows
// (.NET Framework 4.x), so no Visual Studio / SDK install is needed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'native', 'AppAudio.cs');
const out = path.join(__dirname, '..', 'native', 'appaudio.exe');
if (process.platform !== 'win32') {
  console.log('build-native: skipped (Windows only)');
  process.exit(0);
}
if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
  console.log('build-native: up to date');
  process.exit(0);
}
const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) {
  console.error('build-native: csc.exe not found at ' + csc + ' (enable .NET Framework 4.8 in Windows Features)');
  process.exit(1);
}
execFileSync(csc, ['-nologo', '-platform:x64', '-optimize', `-out:${out}`, src], { stdio: 'inherit' });
console.log('build-native: built ' + out);
