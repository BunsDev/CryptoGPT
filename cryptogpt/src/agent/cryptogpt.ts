import { LLMChain } from 'langchain/chains';
import { BaseChatModel } from 'langchain/chat_models/base';
// import { getEmbeddingContextSize, getModelContextSize } from 'langchain/dist/base_language/count_tokens';
// import { FINISH_NAME, ObjectTool } from 'langchain/dist/experimental/autogpt/schema';
import { AutoGPTOutputParser, AutoGPTPrompt } from 'langchain/experimental/autogpt';
import { AIChatMessage, BaseChatMessage, HumanChatMessage, SystemChatMessage } from 'langchain/schema';
import { TokenTextSplitter } from 'langchain/text_splitter';
import { StructuredTool, Tool } from 'langchain/tools';
import { VectorStoreRetriever } from 'langchain/vectorstores/base';
import { NextApiResponse } from 'next';
import { getEmbeddingContextSize, getModelContextSize } from './tokens';

export type ObjectTool = StructuredTool;

export const FINISH_NAME = 'finish';

export interface AutoGPTAction {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
}

export interface AutoGPTInput {
  aiName: string;
  aiRole: string;
  memory: VectorStoreRetriever;
  humanInTheLoop?: boolean;
  outputParser?: AutoGPTOutputParser;
  maxIterations?: number;
}

export class AutoGPT {
  aiName: string;

  memory: VectorStoreRetriever;

  fullMessageHistory: BaseChatMessage[];

  nextActionCount: number;

  chain: LLMChain;

  outputParser: AutoGPTOutputParser;

  tools: ObjectTool[];

  feedbackTool?: Tool;

  maxIterations: number;

  // Currently not generic enough to support any text splitter.
  textSplitter: TokenTextSplitter;

  res?: NextApiResponse;

  constructor({
    aiName,
    memory,
    chain,
    outputParser,
    tools,
    feedbackTool,
    maxIterations,
    res,
  }: Omit<Required<AutoGPTInput>, 'aiRole' | 'humanInTheLoop'> & {
    chain: LLMChain;
    tools: ObjectTool[];
    feedbackTool?: Tool;
    res?: NextApiResponse;
  }) {
    this.aiName = aiName;
    this.memory = memory;
    this.fullMessageHistory = [];
    this.nextActionCount = 0;
    this.chain = chain;
    this.outputParser = outputParser;
    this.tools = tools;
    this.feedbackTool = feedbackTool;
    this.maxIterations = maxIterations;
    const chunkSize = getEmbeddingContextSize(
      'modelName' in memory.vectorStore.embeddings
        ? (memory.vectorStore.embeddings.modelName as string)
        : undefined,
    );
    this.textSplitter = new TokenTextSplitter({
      chunkSize,
      chunkOverlap: Math.round(chunkSize / 10),
    });
    this.res = res;
  }

  static fromLLMAndTools(
    llm: BaseChatModel,
    tools: ObjectTool[],
    {
      aiName,
      aiRole,
      memory,
      maxIterations = 100,
      // humanInTheLoop = false,
      outputParser = new AutoGPTOutputParser(),
    }: AutoGPTInput,
    res?: NextApiResponse,
  ): AutoGPT {
    const prompt = new AutoGPTPrompt({
      aiName,
      aiRole,
      tools,
      tokenCounter: llm.getNumTokens.bind(llm),
      sendTokenLimit: getModelContextSize('modelName' in llm ? (llm.modelName as string) : 'gpt2'),
    });
    // const feedbackTool = humanInTheLoop ? new HumanInputRun() : null;
    const chain = new LLMChain({ llm, prompt });
    return new AutoGPT({
      aiName,
      memory,
      chain,
      outputParser,
      tools,
      // feedbackTool,
      maxIterations,
      res,
    });
  }

  async run(goals: string[]): Promise<string | undefined> {
    const user_input = 'Determine which next command to use, and respond using the format specified above:';
    let loopCount = 0;
    while (loopCount < this.maxIterations) {
      loopCount += 1;

      const { text: assistantReply } = await this.chain.call({
        goals,
        user_input,
        memory: this.memory,
        messages: this.fullMessageHistory,
      });

      // Print the assistant reply
      this.res?.write(assistantReply);
      this.fullMessageHistory.push(new HumanChatMessage(user_input));
      this.fullMessageHistory.push(new AIChatMessage(assistantReply));

      const action = await this.outputParser.parse(assistantReply);
      const tools = this.tools.reduce(
        (acc, tool) => ({ ...acc, [tool.name]: tool }),
        {} as { [key: string]: ObjectTool },
      );
      if (action.name === FINISH_NAME) {
        return action.args.response;
      }
      let result: string;
      if (action.name in tools) {
        const tool = tools[action.name];
        let observation;
        try {
          observation = await tool.call(action.args);
        } catch (e) {
          observation = `Error in args: ${e}`;
        }
        result = `Command ${tool.name} returned: ${observation}`;
      } else if (action.name === 'ERROR') {
        result = `Error: ${action.args}. `;
      } else {
        result = `Unknown command '${action.name}'. Please refer to the 'COMMANDS' list for available commands and only respond in the specified JSON format.`;
      }

      let memoryToAdd = `Assistant Reply: ${assistantReply}\nResult: ${result} `;
      if (this.feedbackTool) {
        const feedback = `\n${await this.feedbackTool.call('Input: ')}`;
        if (feedback === 'q' || feedback === 'stop') {
          console.log('EXITING');
          return 'EXITING';
        }
        memoryToAdd += feedback;
      }

      const documents = await this.textSplitter.createDocuments([memoryToAdd]);
      await this.memory.addDocuments(documents);
      this.fullMessageHistory.push(new SystemChatMessage(result));
    }

    return undefined;
  }
}