# Luau Obfuscator v2

  ## Improvements over v1

  1. **Random opcode mapping** — each build generates a unique shuffled permutation of opcode→byte. Reverser cannot hardcode LOADK=1, RETURN=0 etc.
  2. **Encrypted instruction stream** — instructions packed as 32-bit integers, XOR'd with a rolling 24-bit xorshift key. Raw bytecode array is just noise.
  3. **Dynamic opcode mutation** — every 47 instructions, the op byte is XOR'd with a rotating mask. Opcode values shift mid-execution.
  4. **Rolling per-constant keys** — each string/number constant uses a different key derived from a seed+index LCG chain.
  5. **Number encryption** — doubles stored as 8 encrypted bytes, decoded via string.unpack at runtime.
  6. **~80 fake/decoy handlers** — dispatcher contains handlers for all unused opcodes, making dead-code analysis necessary.
  7. **FORINIT/FORSTEP 16-bit jump offsets** — no loop length limitation (up to ±32767 instructions).

  ## Usage

  ```
  npm start        # serves UI at http://localhost:3000
  ```

  ## API

  - `GET /` — web UI
  - `POST /api/obfuscate` — multipart file upload (.lua/.luau)
  - `POST /api/obfuscate-text` — JSON body: `{code, level}` (level 1–5)
  