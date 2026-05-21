-- Add inline template-source review sessions for the Codex review drawer.
ALTER TYPE "TemplateAgentSessionMode" ADD VALUE IF NOT EXISTS 'REVIEW_TEMPLATE_SOURCE';
