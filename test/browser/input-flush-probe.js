// Does the console DOM contain prior stdout at the moment window.prompt fires?
const { chromium } = require('@playwright/test');
const CODE = 'menu = """\n1. One\n2. Two\n9. Quit\n"""\nprint(menu)\nchoice = input("Enter your choice.")\nprint("got", choice)\n';
(async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext()).newPage();
  await page.addInitScript(() => {
    window.__snap = null;
    const orig = window.prompt;
    window.prompt = function (msg) {
      const el = document.querySelector('#console-output') || document.body;
      window.__snap = { promptMsg: msg, consoleText: (el.innerText || '').slice(-600) };
      return '9';
    };
  });
  await page.goto(process.env.PROBE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  // put the code in the ACE editor
  const set = await page.evaluate((code) => {
    if (window.ace) {
      const nodes = document.querySelectorAll('.ace_editor');
      if (nodes.length) { window.ace.edit(nodes[0]).setValue(code, -1); return 'ace ok'; }
      return 'no ace_editor node';
    }
    return 'no window.ace';
  }, CODE);
  console.log('  editor:', set);
  await page.waitForSelector('a.run-it', { timeout: 20000 });
  await page.click('a.run-it');
  await page.waitForTimeout(35000);
  const finalConsole = await page.evaluate(() => {
    const el = document.querySelector('#console-output') || document.body;
    return (el.innerText || '').slice(-500);
  });
  console.log('  console after run:', JSON.stringify(finalConsole));
  const snap = await page.evaluate(() => window.__snap);
  console.log('  prompt fired:', !!snap);
  if (snap) {
    console.log('  prompt message :', JSON.stringify(snap.promptMsg));
    console.log('  console at that instant:');
    console.log('   ', JSON.stringify(snap.consoleText));
  }
  await b.close();
})();
