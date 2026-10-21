You are the lead reviewer. Answer the statements in QUESTIONS.md about the code in FILES.md; do not redo the work.

Work only with the files in this folder: BRIEF.md (the frozen specification), FILES.md (every file the tickets wrote, in full) and QUESTIONS.md (numbered statements, each with an id and the files it is about). Do not search the web, do not look outside this folder, and do not write any file other than ANSWERS.json.

For each statement decide whether it is true of the code. YES means the statement holds; NO means it does not. Judge across files where a statement needs it. Quote nothing from memory: a line number must come from FILES.md.

Write one file, ANSWERS.json, and nothing else: a JSON array with one object per statement, in the order given, of the exact shape
{"id":"<id from QUESTIONS.md>","answer":"YES" or "NO","file":"<path from FILES.md or null>","line":<line number within that file or null>,"why":"<one line, at most 25 words>"}

No prose before or after the array. Do not fix the code. Do not comment on style.

Then stop.
