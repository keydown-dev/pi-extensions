Please set up a Ralph loop for a small throwaway TypeScript arithmetic-script kata. Use the Ralph planning/start flow if available. Do not implement anything directly in this parent session; create the loop and let Ralph worker iterations do the work.

Loop goal:
Create one basic command-line TypeScript arithmetic script per iteration under a new `.tmp/` folder. Each iteration should also add a matching test for that script.

Constraints:
- Work only inside `.tmp/` unless a minimal package/config change is absolutely required to run the scripts/tests.
- Keep this throwaway and self-contained.
- Use TypeScript.
- Each script must be runnable from the command line using Node.
- Each iteration should add exactly one operation script and its test.
- Prefer simple Node built-ins for tests; avoid introducing dependencies unless necessary.
- Verification for every iteration must run the new test and, if practical, run the script from the command line.

Suggested iterations/todos:
1. Add `.tmp/add.ts` plus a test for addition.
2. Add `.tmp/subtract.ts` plus a test for subtraction.
3. Add `.tmp/multiply.ts` plus a test for multiplication.
4. Add `.tmp/divide.ts` plus a test for division.

Definition of done for each iteration:
- The new script exists in `.tmp/`.
- The new test exists in `.tmp/<script-name>.test.ts`.
- The script accepts command-line numeric arguments and prints the result.
- A matching test exists and passes.
- Verification output is recorded in the Ralph iteration artifacts.

Please propose the Ralph loop packet first, ask me for approval, and after I approve, create the loop. If run/next tools are available, offer to run one iteration at a time so I can observe progress updates.