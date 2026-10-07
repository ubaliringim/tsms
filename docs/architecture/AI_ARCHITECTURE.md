# AI architecture and trust boundaries

Status: accepted direction; no provider integration in Stage 0.

## Provider-neutral capabilities

Domain code depends on application-owned capabilities such as generateText, generateStructured, embed, and moderate, implemented by provider adapters. Provider/model choice may vary by cost, quality, availability, and feature. Do not introduce unused adapter interfaces before their stage needs them.

AI supports document understanding, curriculum/concept extraction, learning-object/question generation, explanations/hints, misconception analysis, and insights. Authentication, authorization, tenant isolation, XP accounting, audit history, identity, subscription truth, and publishing authority remain deterministic application responsibilities.

## Generation and publication

Upload → validation/security processing → extraction/chunking → curriculum/concept mapping → embeddings where useful → generation → automated validation/grounding → teacher review → approval → publication.

Track resource/page/section/chunks, generation/prompt version, provider/model, reviewer, and approval state. Reuse approved content for authorized learners; do not generate the same published curriculum for each student. Explicit statuses/retries/failure visibility belong in asynchronous processing.

## Grounded retrieval and tutoring

Question → trusted tenant context → permission/publication filters → subject/concept filters → relevant approved chunks → controlled prompt → model → grounded response.

Never rely on similarity alone for authorization. Retrieval must prevent cross-school disclosure before model invocation. Avoid whole textbook prompts. Keep system/developer policy, trusted application context, retrieved text, and user input separate. Documents are untrusted data and cannot acquire instruction authority; validate outputs rather than assuming a prompt makes them safe.

Context may include student level, subject, current concept/object, approved chunks, relevant mastery, and recent misconceptions. Omit unrelated profiles, contact details, other students, and unnecessary identifiers. Establish behavior for inadequate evidence, unsafe requests, and uncertain output in the tutoring stage.

## Cost and observability

Measure tenant, feature, provider/model, token counts, latency, estimated cost, and outcome without indiscriminately logging private prompt contents. Introduce quotas, caching/reuse, and retry limits with the feature. Use pgvector initially when semantic retrieval is required. No AI API keys are needed in Stage 0.
