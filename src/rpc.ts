import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const MAX_QUESTION = 12_000
export const MAX_EXCHANGES = 24
export const MAX_TRANSCRIPT = 240_000

export const Exchange = z.object({
  question: z.string().min(1).max(MAX_QUESTION),
  answer: z.string().min(1).max(128_000),
  time: z.number().int().nonnegative(),
})
export type Exchange = z.infer<typeof Exchange>

const exchanges = z.array(Exchange).max(MAX_EXCHANGES).refine(
  (items) => items.reduce((sum, item) => sum + item.question.length + item.answer.length, 0) <= MAX_TRANSCRIPT,
  "This aside is full. Start a new aside after expanding it to a fork.",
)
const sessionID = z.string().regex(/^ses/)
export const Question = z.object({ sessionID, requestID: z.string().uuid().optional(), question: z.string().trim().min(1).max(MAX_QUESTION), exchanges })
export type Question = z.infer<typeof Question>
export const Promotion = z.object({ sessionID, operationID: z.string().uuid(), exchanges: exchanges.min(1) })
export type Promotion = z.infer<typeof Promotion>

export const Btw = Rpc.define({
  id: "opencodev2-btw",
  events: {},
  methods: {
    ask: {
      input: Question,
      output: z.object({ text: z.string().max(128_000), model: z.string() }),
      errors: { failed: z.object({ message: z.string() }) },
    },
    cancel: {
      input: z.object({ sessionID, requestID: z.string().uuid() }),
      output: z.object({ cancelled: z.boolean() }),
    },
  },
})
