#!/usr/bin/env bash
# PreToolUse hook — blocks `git push` and `git commit` unless the user has
# explicitly approved them in the current turn. Matches on the Bash tool
# only; emits a JSON decision {permissionDecision:"deny"} back to the
# Claude Code runner when the command contains `git push` or `git commit`.
# Non-matching Bash calls exit 0 silently (continue as normal).
#
# Rationale: memory/feedback_local_only_dev.md — master auto-deploys to
# production via Vercel, so an unapproved push ships to real users. This
# script is the seatbelt for when the memory rule doesn't stop Claude on
# its own. See the troubleshooting section in the same memory file for
# the original failure mode (2026-04-21).
#
# Implementation note: uses node (not jq) because this repo's dev machine
# doesn't have jq available on Windows git-bash. Node is already required
# by the Next.js project, so it's always present.

node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const c=(j.tool_input&&j.tool_input.command)||"";if(/git\s+(push|commit)(\s|$)/.test(c)){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"CONFIRM: git push / git commit on LeadStart. master auto-deploys to production. Approve only if the user explicitly asked for this commit or push in the current turn — see memory/feedback_local_only_dev.md."}}))}}catch(e){}})'
