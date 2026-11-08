import { runAllVerificationSuites } from '../lib/verificationSuite';

const summary = runAllVerificationSuites();

console.log('==============================================================');
console.log('ORR PULSE — AUTOMATED PILOT VERIFICATION SUITE');
console.log(`Executed at: ${summary.executedAtIst}`);
console.log('==============================================================');

for (const res of summary.results) {
  const badge = res.passed ? '[PASS]' : '[FAIL]';
  console.log(`${badge} ${res.category}: ${res.name} (${res.assertionsRun} assertions)`);
  console.log(`       Evidence: ${res.evidence}`);
}

console.log('--------------------------------------------------------------');
console.log(
  `Summary: ${summary.passedTests}/${summary.totalTests} test suites passed (${summary.totalAssertions} total assertions).`
);
console.log('==============================================================');

if (!summary.allPassed) {
  process.exit(1);
}
