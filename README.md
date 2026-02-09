# mordecai-workers

Workers + scheduler for Mordecai. This repo owns the queue consumers and the
periodic scheduler. The HTTP + Twilio WebSocket endpoint lives in the API repo.
Models/config/logger are imported directly from the API repo to keep a single
source of truth (DRY).

## Job model (current)
Queue: `case-actions`

Jobs:
1. `CALL_CASE`
   - Enqueued by the scheduler when a debt case is due.
   - Worker starts a Twilio call to the debtor phone using `TWILIO_VOICE_URL`
     (the API endpoint that returns TwiML with `<Connect><Stream>`).
   - Worker stores the Twilio `callSid` in `interaction_logs.provider_ref`.

2. `SYNC_CALL_SUMMARY` (reserved)
   - Placeholder for future: read call summary from S3 and update DB.

## Roles
- Scheduler: selects due cases and enqueues `CALL_CASE` jobs.
- Worker: consumes jobs and executes side effects (Twilio calls + DB updates).

## Requirements
- Node >= 18
- Postgres access
- Redis URL (Upstash or local)
- Twilio credentials (for CALL_CASE)
- Git access to the API repo (dependency: `mordcai-api`)

## Local run
```bash
npm install
npm run worker
npm run scheduler
```

## Env
See `.env.example`.
