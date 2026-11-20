import { loadEnvironment, hostedConfigurationIssues } from '../apps/api/src/config.ts';
const config = loadEnvironment();
const issues = hostedConfigurationIssues(config);
console.log(JSON.stringify({ configured: issues.length === 0, checks: 'local configuration only; no provider credentials or quotas have been verified', speech: config.LIVE_SPEECH_PROVIDER, missing: issues }, null, 2));
if (issues.length) process.exitCode = 1;
