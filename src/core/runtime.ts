import { addHeader, composeContext } from "./context.ts";
import {
  defaultEvaluators,
  evaluationTemplate,
  formatEvaluatorConditions,
  formatEvaluatorExamples,
  formatEvaluatorNames,
  formatEvaluators,
} from "./evaluators.ts";
import { MemoryManager } from "./memory.ts";
import { parseBooleanFromText, parseJsonArrayFromText, parseJSONObjectFromText, parseShouldRespondFromText } from "./parsing.ts";
import {
  Character,
  Content,
  Goal,
  IAgentRuntime,
  IBrowserService,
  IDatabaseAdapter,
  IImageRecognitionService,
  IMemoryManager,
  IPdfService,
  ITranscriptionService,
  IVideoService,
  Media,
  Provider,
  State,
  type Action,
  type Evaluator,
  type Message
} from "./types.ts";

import {
  default as tiktoken,
  default as TikToken,
  TiktokenModel,
} from "tiktoken";
import { names, uniqueNamesGenerator } from "unique-names-generator";
import { formatFacts } from "../evaluators/fact.ts";
import { BrowserService } from "../services/browser.ts";
import ImageDescriptionService from "../services/image.ts";
import LlamaService from "../services/llama.ts";
import { PdfService } from "../services/pdf.ts";
import { SpeechService } from "../services/speech.ts";
import { TranscriptionService } from "../services/transcription.ts";
import { VideoService } from "../services/video.ts";
import { wordsToPunish } from "../services/wordsToPunish.ts";
import {
  composeActionExamples,
  formatActionConditions,
  formatActionNames,
  formatActions,
} from "./actions.ts";
import { zeroUuid } from "./constants.ts";
import defaultCharacter from "./defaultCharacter.ts";
import { formatGoalsAsString, getGoals } from "./goals.ts";
import { formatActors, formatMessages, getActorDetails } from "./messages.ts";
import { formatPosts } from "./posts.ts";
import { defaultProviders, getProviders } from "./providers.ts";
import settings from "./settings.ts";
import { UUID, type Actor, type Memory } from "./types.ts";

/**
 * Represents the runtime environment for an agent, handling message processing,
 * action registration, and interaction with external services like OpenAI and Supabase.
 */
export class AgentRuntime implements IAgentRuntime {
  /**
   * Default count for recent messages to be kept in memory.
   * @private
   */
  readonly #conversationLength = 32 as number;
  /**
   * The ID of the agent
   */
  agentId: UUID = zeroUuid;
  /**
   * The base URL of the server where the agent's requests are processed.
   */
  serverUrl = "http://localhost:7998";

  /**
   * The database adapter used for interacting with the database.
   */
  databaseAdapter: IDatabaseAdapter;

  /**
   * Authentication token used for securing requests.
   */
  token: string | null;

  /**
   * Custom actions that the agent can perform.
   */
  actions: Action[] = [];

  /**
   * Evaluators used to assess and guide the agent's responses.
   */
  evaluators: Evaluator[] = [];

  /**
   * Context providers used to provide context for message generation.
   */
  providers: Provider[] = [];

  /**
   * The model to use for completion.
   */
  model = "gpt-4o-mini";

  /**
   * The model to use for embedding.
   */
  embeddingModel = "text-embedding-3-small";

  /**
   * Local Llama if no OpenAI key is present
   */
  llamaService: LlamaService | null = null;

  // services
  speechService: typeof SpeechService;

  transcriptionService: ITranscriptionService;

  imageDescriptionService: IImageRecognitionService;

  browserService: IBrowserService;

  videoService: IVideoService;

  pdfService: IPdfService;

  /**
   * Fetch function to use
   * Some environments may not have access to the global fetch function and need a custom fetch override.
   */
  fetch = fetch;

  /**
   * The character to use for the agent
   */
  character: Character;

  /**
   * Store messages that are sent and received by the agent.
   */
  messageManager: IMemoryManager;

  /**
   * Store and recall descriptions of users based on conversations.
   */
  descriptionManager: IMemoryManager;

  /**
   * Manage the fact and recall of facts.
   */
  factManager: IMemoryManager;

  /**
   * Manage the creation and recall of static information (documents, historical game lore, etc)
   */
  loreManager: IMemoryManager;

  /**
   * Creates an instance of AgentRuntime.
   * @param opts - The options for configuring the AgentRuntime.
   * @param opts.conversationLength - The number of messages to hold in the recent message cache.
   * @param opts.token - The JWT token, can be a JWT token if outside worker, or an OpenAI token if inside worker.
   * @param opts.serverUrl - The URL of the worker.
   * @param opts.actions - Optional custom actions.
   * @param opts.evaluators - Optional custom evaluators.
   * @param opts.providers - Optional context providers.
   * @param opts.model - The model to use for completion.
   * @param opts.embeddingModel - The model to use for embedding.
   * @param opts.agentId - Optional ID of the agent.
   * @param opts.databaseAdapter - The database adapter used for interacting with the database.
   * @param opts.fetch - Custom fetch function to use for making requests.
   */

  constructor(opts: {
    conversationLength?: number; // number of messages to hold in the recent message cache
    agentId?: UUID; // ID of the agent
    character?: Character; // The character to use for the agent
    token: string; // JWT token, can be a JWT token if outside worker, or an OpenAI token if inside worker
    serverUrl?: string; // The URL of the worker
    actions?: Action[]; // Optional custom actions
    evaluators?: Evaluator[]; // Optional custom evaluators
    providers?: Provider[];
    model?: string; // The model to use for completion
    embeddingModel?: string; // The model to use for embedding
    databaseAdapter: IDatabaseAdapter; // The database adapter used for interacting with the database
    fetch?: typeof fetch | unknown;
    speechModelPath?: string;
  }) {
    this.#conversationLength =
      opts.conversationLength ?? this.#conversationLength;
    this.databaseAdapter = opts.databaseAdapter;
    this.agentId = opts.agentId ?? zeroUuid;
    this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;
    this.character = opts.character || defaultCharacter;
    if (!opts.databaseAdapter) {
      throw new Error("No database adapter provided");
    }

    this.messageManager = new MemoryManager({
      runtime: this,
      tableName: "messages",
    });

    this.descriptionManager = new MemoryManager({
      runtime: this,
      tableName: "descriptions",
    });

    this.factManager = new MemoryManager({
      runtime: this,
      tableName: "facts",
    });

    this.loreManager = new MemoryManager({
      runtime: this,
      tableName: "lore",
    });

    this.serverUrl = opts.serverUrl ?? this.serverUrl;
    this.model = opts.model ?? this.model;
    this.embeddingModel = opts.embeddingModel ?? this.embeddingModel;
    if (!this.serverUrl) {
      console.warn("No serverUrl provided, defaulting to localhost");
    }

    this.token = opts.token;

    (opts.actions ?? []).forEach((action) => {
      this.registerAction(action);
    });

    (opts.evaluators ?? defaultEvaluators).forEach((evaluator) => {
      this.registerEvaluator(evaluator);
    });
    (opts.providers ?? defaultProviders).forEach((provider) => {
      this.registerContextProvider(provider);
    });

    if (!settings.OPENAI_API_KEY && !this.llamaService) {
      this.llamaService = new LlamaService();
    }

    this.transcriptionService = new TranscriptionService();

    this.imageDescriptionService = new ImageDescriptionService(this);

    this.browserService = new BrowserService(this);

    this.videoService = new VideoService(this);

    this.pdfService = new PdfService();

    // static class, no need to instantiate but we can access it like a class instance
    this.speechService = SpeechService;
    if (opts.speechModelPath) {
      SpeechService.modelPath = opts.speechModelPath;
    }
  }

  /**
   * Get the number of messages that are kept in the conversation buffer.
   * @returns The number of recent messages to be kept in memory.
   */
  getConversationLength() {
    return this.#conversationLength;
  }

  /**
   * Register an action for the agent to perform.
   * @param action The action to register.
   */
  registerAction(action: Action) {
    this.actions.push(action);
  }

  /**
   * Register an evaluator to assess and guide the agent's responses.
   * @param evaluator The evaluator to register.
   */
  registerEvaluator(evaluator: Evaluator) {
    this.evaluators.push(evaluator);
  }

  /**
   * Register a context provider to provide context for message generation.
   * @param provider The context provider to register.
   */
  registerContextProvider(provider: Provider) {
    this.providers.push(provider);
  }

  /**
   * Send a message to the model for a text completion - receive a string back and parse how you'd like
   * @param opts - The options for the completion request.
   * @param opts.context The context of the message to be completed.
   * @param opts.stop A list of strings to stop the completion at.
   * @param opts.model The model to use for completion.
   * @param opts.frequency_penalty The frequency penalty to apply to the completion.
   * @param opts.presence_penalty The presence penalty to apply to the completion.
   * @param opts.temperature The temperature to apply to the completion.
   * @param opts.max_context_length The maximum length of the context to apply to the completion.
   * @returns The completed message.
   */
  async completion({
    context = "",
    stop = [],
    model = this.model,
    frequency_penalty = 0.0,
    presence_penalty = 0.0,
    temperature = 0.3,
    max_context_length = settings.OPENAI_API_KEY ? 127000 : 8000,
    max_response_length = settings.OPENAI_API_KEY ? 8192 : 4096,
  }): Promise<string> {
    let retryLength = 1000; // exponential backoff
    for (let triesLeft = 5; triesLeft > 0; triesLeft--) {
      try {
        context = await this.trimTokens(
          "gpt-4o-mini",
          context,
          max_context_length,
        );
        if (!settings.OPENAI_API_KEY) {
          console.log("queueing text completion")
          const result = await this.llamaService.queueTextCompletion(
            context,
            temperature,
            stop,
            frequency_penalty,
            presence_penalty,
            max_response_length,
          );
          return result;
        } else {
          const biasValue = -30.0;
          const encoding = TikToken.encoding_for_model("gpt-4o-mini");

          const tokenIds = [
            ...new Set(
              await Promise.all(
                wordsToPunish.map((word) => encoding.encode(word)[0]),
              ),
            ),
          ];

          const logit_bias = tokenIds.reduce((acc, tokenId) => {
            acc[tokenId] = biasValue;
            return acc;
          }, {});

          const requestOptions = {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify({
              stop,
              model,
              frequency_penalty,
              presence_penalty,
              temperature,
              max_tokens: max_response_length,
              logit_bias,
              messages: [
                {
                  role: "user",
                  content: context,
                },
              ],
            }),
          };
          console.log("requestOptions", requestOptions)
          const response = await fetch(
            `${this.serverUrl}/chat/completions`,
            requestOptions,
          );

          if (!response.ok) {
            throw new Error(
              "OpenAI API Error: " +
              response.status +
              " " +
              response.statusText,
            );
          }

          const body = await response.json();

          interface OpenAIResponse {
            choices: Array<{ message: { content: string } }>;
          }

          const content = (body as OpenAIResponse).choices?.[0]?.message
            ?.content;
          if (!content) {
            throw new Error("No content in response");
          }
          return content;
        }
      } catch (error) {
        console.error("ERROR:", error);
        // wait for 2 seconds
        retryLength *= 2;
        await new Promise((resolve) => setTimeout(resolve, retryLength));
        console.log("Retrying...");
      }
    }
    throw new Error(
      "Failed to complete message after 5 tries, probably a network connectivity, model or API key issue",
    );
  }

  /**
   * Truncate the context to the maximum length allowed by the model.
   * @param model The model to use for completion.
   * @param context The context of the message to be completed.
   * @param max_context_length The maximum length of the context to apply to the completion.
   * @returns
   */
  async trimTokens(model, context, maxTokens) {
    // Count tokens and truncate context if necessary
    const encoding = tiktoken.encoding_for_model(model as TiktokenModel);
    let tokens = encoding.encode(context);
    const textDecoder = new TextDecoder();
    if (tokens.length > maxTokens) {
      tokens = tokens.reverse().slice(maxTokens).reverse();

      context = textDecoder.decode(encoding.decode(tokens));
    }
    return context;
  }

  async shouldRespondCompletion({
    context = "",
    stop = [],
    model = this.model,
    frequency_penalty = 0.0,
    presence_penalty = 0.0,
    temperature = 0.3,
    max_context_length = settings.OPENAI_API_KEY ? 127000 : 8000,
    max_response_length = settings.OPENAI_API_KEY ? 8192 : 4096,
  }): Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
    let retryDelay = 1000;

    while (true) {
      try {
        const response = await this.completion({
          context,
          stop,
          model,
          frequency_penalty,
          presence_penalty,
          temperature,
          max_context_length,
          max_response_length,
        });

        const parsedResponse = parseShouldRespondFromText(response.trim());
        if (parsedResponse) {
          return parsedResponse;
        }
      } catch (error) {
        console.error("Error in shouldRespondCompletion:", error);
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay *= 2;
    }
  }

  async booleanCompletion({
    context = "",
    stop = [],
    model = this.model,
    frequency_penalty = 0.0,
    presence_penalty = 0.0,
    temperature = 0.3,
    max_context_length = settings.OPENAI_API_KEY ? 127000 : 8000,
    max_response_length = settings.OPENAI_API_KEY ? 8192 : 4096,
  }): Promise<boolean> {
    let retryDelay = 1000;

    while (true) {
      try {
        const response = await this.completion({
          context,
          stop,
          model,
          frequency_penalty,
          presence_penalty,
          temperature,
          max_context_length,
          max_response_length,
        });

        const parsedResponse = parseBooleanFromText(response.trim());
        if (parsedResponse !== null) {
          return parsedResponse;
        }
      } catch (error) {
        console.error("Error in booleanCompletion:", error);
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay *= 2;
    }
  }

  async stringArrayCompletion({
    context = "",
    stop = [],
    model = this.model,
    frequency_penalty = 0.0,
    presence_penalty = 0.0,
    temperature = 0.3,
    max_context_length = settings.OPENAI_API_KEY ? 127000 : 8000,
    max_response_length = settings.OPENAI_API_KEY ? 8192 : 4096,
  }): Promise<string[]> {
    let retryDelay = 1000;

    while (true) {
      try {
        const response = await this.completion({
          context,
          stop,
          model,
          frequency_penalty,
          presence_penalty,
          temperature,
          max_context_length,
          max_response_length,
        });

        const parsedResponse = parseJsonArrayFromText(response);
        if (parsedResponse) {
          return parsedResponse;
        }
      } catch (error) {
        console.error("Error in stringArrayCompletion:", error);
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay *= 2;
    }
  }

  async objectArrayCompletion({
    context = "",
    stop = [],
    model = this.model,
    frequency_penalty = 0.0,
    presence_penalty = 0.0,
    temperature = 0.3,
    max_context_length = settings.OPENAI_API_KEY ? 127000 : 8000,
    max_response_length = settings.OPENAI_API_KEY ? 8192 : 4096,
  }): Promise<any[]> {
    let retryDelay = 1000;

    while (true) {
      try {
        const response = await this.completion({
          context,
          stop,
          model,
          frequency_penalty,
          presence_penalty,
          temperature,
          max_context_length,
          max_response_length,
        });


        const parsedResponse = parseJsonArrayFromText(response);
        if (parsedResponse) {
          return parsedResponse;
        }
      } catch (error) {
        console.error("Error in stringArrayCompletion:", error);
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay *= 2;
    }
  }


  /**
   * Send a message to the model for completion.
   * @param opts - The options for the completion request.
   * @param opts.context The context of the message to be completed.
   * @param opts.stop A list of strings to stop the completion at.
   * @param opts.model The model to use for completion.
   * @param opts.frequency_penalty The frequency penalty to apply to the completion.
   * @param opts.presence_penalty The presence penalty to apply to the completion.
   * @param opts.temperature The temperature to apply to the completion.
   * @param opts.max_context_length The maximum length of the context to apply to the completion.
   * @returns The completed message.
   */
  async messageCompletion({
    context = "",
    stop = [],
    model = this.model,
    frequency_penalty = 0.0,
    presence_penalty = 0.0,
    temperature = 0.3,
    max_context_length = settings.OPENAI_API_KEY ? 127000 : 8000,
    max_response_length = settings.OPENAI_API_KEY ? 8192 : 4096,
  }): Promise<Content> {
    context = await this.trimTokens("gpt-4o-mini", context, max_context_length);
    let retryLength = 1000; // exponential backoff
    while (true) {
      try {
        const response = await this.completion({
          context,
          stop,
          model,
          frequency_penalty,
          presence_penalty,
          temperature,
          max_context_length,
          max_response_length,
        });

        // try parsing the response as JSON, if null then try again
        const parsedContent = parseJSONObjectFromText(
          response,
        ) as Content;

        if (!parsedContent) {
          continue;
        }

        return parsedContent;
      } catch (error) {
        console.error("ERROR:", error);
        // wait for 2 seconds
        retryLength *= 2;
        await new Promise((resolve) => setTimeout(resolve, retryLength));
        console.log("Retrying...");
      }
    }
    throw new Error(
      "Failed to complete message after 5 tries, probably a network connectivity, model or API key issue",
    );
  }

  /**
   * Send a message to the OpenAI API for embedding.
   * @param input The input to be embedded.
   * @returns The embedding of the input.
   */
  async embed(input: string) {
    if (!settings.OPENAI_API_KEY) {
      return await this.llamaService.getEmbeddingResponse(input);
    }
    const embeddingModel = this.embeddingModel;

    // Check if we already have the embedding in the lore
    const cachedEmbedding = await this.retrieveCachedEmbedding(input);
    if (cachedEmbedding) {
      return cachedEmbedding;
    }

    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        input,
        model: embeddingModel,
        length: 1536,
      }),
    };
    try {
      const response = await fetch(
        `${this.serverUrl}/embeddings`,
        requestOptions,
      );

      if (!response.ok) {
        throw new Error(
          "OpenAI API Error: " + response.status + " " + response.statusText,
        );
      }

      interface OpenAIEmbeddingResponse {
        data: Array<{ embedding: number[] }>;
      }

      const data: OpenAIEmbeddingResponse = await response.json();

      return data?.data?.[0].embedding;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async retrieveCachedEmbedding(input: string) {
    const similaritySearchResult =
      await this.messageManager.getCachedEmbeddings(input);
    if (similaritySearchResult.length > 0) {
      return similaritySearchResult[0].embedding;
    }
    return null;
  }

  /**
   * Process the actions of a message.
   * @param message The message to process.
   * @param content The content of the message to process actions from.
   */
  async processActions(
    message: Message,
    content: Content,
    state?: State,
    callback?: (response: Content) => void,
  ): Promise<void> {
    if (!content.action) {
      return;
    }

    const action = this.actions.find(
      (a: { name: string }) => a.name === content.action,
    )!;

    if (!action) {
      return console.warn("No action found for", content.action);
    }

    if (!action.handler) {
      return;
    }

    await action.handler(this, message, state, {}, callback);
  }

  /**
   * Evaluate the message and state using the registered evaluators.
   * @param message The message to evaluate.
   * @param state The state of the agent.
   * @returns The results of the evaluation.
   */
  async evaluate(message: Message, state?: State) {
    const evaluatorPromises = this.evaluators.map(
      async (evaluator: Evaluator) => {
        if (!evaluator.handler) {
          return null;
        }
        const result = await evaluator.validate(this, message, state);
        if (result) {
          return evaluator;
        }
        return null;
      },
    );

    const resolvedEvaluators = await Promise.all(evaluatorPromises);
    const evaluatorsData = resolvedEvaluators.filter(Boolean);

    // if there are no evaluators this frame, return
    if (evaluatorsData.length === 0) {
      return [];
    }

    const evaluators = formatEvaluators(evaluatorsData as Evaluator[]);
    const evaluatorNames = formatEvaluatorNames(evaluatorsData as Evaluator[]);
    const evaluatorConditions = formatEvaluatorConditions(
      evaluatorsData as Evaluator[],
    );

    const context = composeContext({
      state: {
        ...state,
        evaluators,
        evaluatorNames,
        evaluatorConditions,
      } as State,
      template: evaluationTemplate,
    });

    const result = await this.completion({
      context,
    });

    const parsedResult = parseJsonArrayFromText(result) as unknown as string[];

    this.evaluators
      .filter((evaluator: Evaluator) => parsedResult?.includes(evaluator.name))
      .forEach((evaluator: Evaluator) => {
        if (!evaluator?.handler) return;

        evaluator.handler(this, message);
      });

    return parsedResult;
  }

  /**
   * Ensure the existence of a participant in the room. If the participant does not exist, they are added to the room.
   * @param user_id - The user ID to ensure the existence of.
   * @throws An error if the participant cannot be added.
   */
  async ensureParticipantExists(user_id: UUID, room_id: UUID) {
    const participants =
      await this.databaseAdapter.getParticipantsForAccount(user_id);

    if (participants?.length === 0) {
      await this.databaseAdapter.addParticipant(user_id, room_id);
    }
  }

  /**
   * Ensure the existence of a user in the database. If the user does not exist, they are added to the database.
   * @param user_id - The user ID to ensure the existence of.
   * @param userName - The user name to ensure the existence of.
   * @returns
   */

  async ensureUserExists(
    user_id: UUID,
    userName: string | null,
    name: string | null,
  ) {
    const account = await this.databaseAdapter.getAccountById(user_id);
    if (!account) {
      await this.databaseAdapter.createAccount({
        id: user_id,
        name: name || userName || "Unknown User",
        username: userName || name || "Unknown",
        email: (userName || "Bot") + "@discord", // Temporary
        details: { summary: "" },
      });
      console.log(`User ${userName} created successfully.`);
    }
  }

  async ensureParticipantInRoom(user_id: UUID, roomId: UUID) {
    const participants =
      await this.databaseAdapter.getParticipantsForRoom(roomId);
    if (!participants.includes(user_id)) {
      await this.databaseAdapter.addParticipant(user_id, roomId);
      console.log(`User ${user_id} linked to room ${roomId} successfully.`);
    }
  }

  /**
   * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
   * and agent are added as participants. The room ID is returned.
   * @param user_id - The user ID to create a room with.
   * @returns The room ID of the room between the agent and the user.
   * @throws An error if the room cannot be created.
   */
  async ensureRoomExists(roomId: UUID) {
    const room = await this.databaseAdapter.getRoom(roomId);
    if (!room) {
      await this.databaseAdapter.createRoom(roomId);
      console.log(`Room ${roomId} created successfully.`);
    }
  }

  /**
   * Compose the state of the agent into an object that can be passed or used for response generation.
   * @param message The message to compose the state from.
   * @returns The state of the agent.
   */
  async composeState(
    message: Message,
    additionalKeys: { [key: string]: unknown } = {},
  ) {
    const { user_id, room_id } = message;

    const conversationLength = this.getConversationLength();
    const recentFactsCount = Math.ceil(this.getConversationLength() / 2);
    const relevantFactsCount = Math.ceil(this.getConversationLength() / 2);

    const [actorsData, recentMessagesData, recentFactsData, goalsData]: [
      Actor[],
      Memory[],
      Memory[],
      Goal[],
    ] = await Promise.all([
      getActorDetails({ runtime: this, room_id }),
      this.messageManager.getMemories({
        room_id,
        count: conversationLength,
        unique: false,
      }),
      this.factManager.getMemories({
        room_id,
        count: recentFactsCount,
      }),
      getGoals({
        runtime: this,
        count: 10,
        onlyInProgress: false,
        room_id,
      }),
    ]);

    const goals = formatGoalsAsString({ goals: goalsData });

    let relevantFactsData: Memory[] = [];

    if (recentFactsData.length > recentFactsCount) {
      relevantFactsData = (
        await this.factManager.searchMemoriesByEmbedding(
          recentFactsData[0].embedding!,
          {
            room_id,
            count: relevantFactsCount,
          },
        )
      ).filter((fact: Memory) => {
        return !recentFactsData.find(
          (recentFact: Memory) => recentFact.id === fact.id,
        );
      });
    }

    const actors = formatActors({ actors: actorsData ?? [] });

    const recentMessageData = {
      actors: actorsData ?? [],
      messages: recentMessagesData.map((memory: Memory) => {
        const newMemory = { ...memory };
        delete newMemory.embedding;
        return newMemory;
      }),
    };

    const recentMessages = formatMessages(recentMessageData);

    const recentPosts = formatPosts(recentMessageData);

    const recentFacts = formatFacts(recentFactsData);
    const relevantFacts = formatFacts(relevantFactsData);

    // const lore = formatLore(loreData);

    const senderName = actorsData?.find(
      (actor: Actor) => actor.id === user_id,
    )?.name;

    console.log("actorsData", actorsData);

    // TODO: We may wish to consolidate and just accept character.name here instead of the actor name
    const agentName =
      actorsData?.find((actor: Actor) => actor.id === this.agentId)?.name ||
      this.character.name;

    let allAttachments = message.content.attachments || [];

    if (recentMessagesData && Array.isArray(recentMessagesData)) {
      const lastMessageWithAttachment = recentMessagesData.find(
        (msg) => msg.content.attachments && msg.content.attachments.length > 0,
      );

      if (lastMessageWithAttachment) {
        const lastMessageTime = lastMessageWithAttachment.created_at.getTime();
        const oneHourBeforeLastMessage = lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

        allAttachments = recentMessagesData
          .reverse()
          .map((msg) => {
            const msgTime = msg.created_at.getTime();
            const isWithinTime =
              msgTime >= oneHourBeforeLastMessage && msgTime <= lastMessageTime;
            const attachments = msg.content.attachments || [];
            // if the message is out of the time range, set the attachment 'text' to '[Hidden]'
            if (!isWithinTime) {
              attachments.forEach((attachment) => {
                attachment.text = "[Hidden]";
              });
            }
            return attachments;
          })
          .flat();
      }
    }

    const formattedAttachments = allAttachments
      .map(
        (attachment) =>
          `ID: ${attachment.id}
Name: ${attachment.title} 
URL: ${attachment.url}
Type: ${attachment.source}
Description: ${attachment.description}
Text: ${attachment.text}
  `,
      )
      .join("\n");

    // randomly get 3 bits of lore and join them into a paragraph, divided by \n
    let lore = "";
    // Assuming this.lore is an array of lore bits
    if (this.character.lore && this.character.lore.length > 0) {
      const shuffledLore = [...this.character.lore].sort(
        () => Math.random() - 0.5,
      );
      const selectedLore = shuffledLore.slice(0, 3);
      lore = selectedLore.join("\n");
    }

    const formattedCharacterPostExamples = this.character.postExamples
      .map((post) => {
        let messageString = `${post}`;
        return messageString;
      })
      .join("\n");

    const formattedCharacterMessageExamples = this.character.messageExamples
      .map((example) => {
        const exampleNames = Array.from({ length: 5 }, () =>
          uniqueNamesGenerator({ dictionaries: [names] }),
        );

        return example
          .map((message) => {
            let messageString = `${message.user}: ${message.content.text}`;
            exampleNames.forEach((name, index) => {
              const placeholder = `{{user${index + 1}}}`;
              messageString = messageString.replaceAll(placeholder, name);
            });
            return messageString;
          })
          .join("\n");
      })
      .join("\n\n");

    const getRecentInteractions = async (
      userA: UUID,
      userB: UUID,
    ): Promise<Memory[]> => {
      // Find all rooms where userA and userB are participants
      const rooms = await this.databaseAdapter.getRoomsForParticipants([
        userA,
        userB,
      ]);

      // Fetch recent messages from the rooms
      const recentMessages: Memory[] = [];
      for (const room_id of rooms) {
        const roomMessages = await this.messageManager.getMemories({
          room_id,
          count: 10, // Adjust the count as needed
          unique: false,
          user_ids: [userA, userB],
        });
        recentMessages.push(...roomMessages);
      }

      // Sort messages by timestamp in descending order
      recentMessages.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

      // Take the most recent messages
      const recentInteractionsData = recentMessages.slice(0, 10); // Adjust the count as needed
      return recentInteractionsData;
    };

    const recentInteractions =
      user_id !== this.agentId
        ? await getRecentInteractions(user_id, this.agentId)
        : [];

    const getRecentMessageInteractions = async (
      recentInteractionsData: Memory[],
    ): Promise<string> => {
      // Format the recent messages
      const formattedInteractions = recentInteractionsData
        .map((message) => {
          const sender =
            message.user_id === this.agentId ? this.character.name : "User";
          return `${sender}: ${message.content.text}`;
        })
        .join("\n");

      return formattedInteractions;
    };

    const formattedMessageInteractions =
      await getRecentMessageInteractions(recentInteractions);

    const getRecentPostInteractions = async (
      recentInteractionsData: Memory[],
    ): Promise<string> => {
      // Format the recent posts
      const formattedInteractions = recentInteractionsData
        .map((message) => {
          const sender =
            message.user_id === this.agentId ? this.character.name : "User";
          return `${sender}: ${message.content.text}`;
        })
        .join("\n");

      return formattedInteractions;
    };

    const formattedPostInteractions =
      await getRecentPostInteractions(recentInteractions);

    const initialState = {
      agentId: this.agentId,
      // Character file stuff
      agentName,
      bio: this.character.bio || "",
      lore,
      adjective:
        this.character.adjectives && this.character.adjectives.length > 0
          ? this.character.adjectives[
          Math.floor(Math.random() * this.character.adjectives.length)
          ]
          : "",
      // Recent interactions between the sender and receiver, formatted as messages
      recentMessageInteractions: formattedMessageInteractions,
      // Recent interactions between the sender and receiver, formatted as posts
      recentPostInteractions: formattedPostInteractions,
      // Raw memory[] array of interactions
      recentInteractionsData: recentInteractions,
      // randomly pick one topic
      topic:
        this.character.topics && this.character.topics.length > 0
          ? this.character.topics[
          Math.floor(Math.random() * this.character.topics.length)
          ]
          : null,
      topics:
        this.character.topics && this.character.topics.length > 0
          ? addHeader(
            `### Topics for ${this.character.topics}`,
            this.character.topics
              .sort(() => 0.5 - Math.random())
              .slice(0, 10)
              .join(", "),
          )
          : "",
      characterPostExamples:
        formattedCharacterPostExamples &&
          formattedCharacterPostExamples.replaceAll("\n", "").length > 0
          ? addHeader(
            `### Example Posts for ${this.character.name}`,
            formattedCharacterPostExamples,
          )
          : "",
      characterMessageExamples:
        formattedCharacterMessageExamples &&
          formattedCharacterMessageExamples.replaceAll("\n", "").length > 0
          ? addHeader(
            `### Example Conversations for ${this.character.name}`,
            formattedCharacterMessageExamples,
          )
          : "",
      messageDirections:
        this.character?.style?.all?.length > 0 ||
          this.character?.style?.chat.length > 0
          ? addHeader(
            "### Message Directions for " + this.character.name,
            (this.character?.style?.all?.join("\n") || "") +
            (this.character?.style?.all?.length > 0 &&
              this.character?.style?.chat.length > 0
              ? "\n"
              : "") +
            (this.character?.style?.chat?.join("\n") || ""),
          )
          : "",
      postDirections:
        this.character?.style?.all?.length > 0 ||
          this.character?.style?.post.length > 0
          ? addHeader(
            "### Post Directions for " + this.character.name,
            (this.character?.style?.all?.join("\n") || "") +
            (this.character?.style?.all?.length > 0 &&
              this.character?.style?.post.length > 0
              ? "\n"
              : "") +
            (this.character?.style?.post?.join("\n") || ""),
          )
          : "",
      // Agent runtime stuff
      senderName,
      actors:
        actors && actors.length > 0 ? addHeader("### Actors", actors) : "",
      actorsData,
      room_id,
      goals:
        goals && goals.length > 0
          ? addHeader(
            "### Goals\n{{agentName}} should prioritize accomplishing the objectives that are in progress.",
            goals,
          )
          : "",
      goalsData,
      recentMessages:
        recentMessages && recentMessages.length > 0
          ? addHeader("### Conversation Messages", recentMessages)
          : "",
      recentPosts:
        recentPosts && recentPosts.length > 0
          ? addHeader("### Recent Posts", recentPosts)
          : "",
      recentMessagesData,
      recentFacts:
        recentFacts && recentFacts.length > 0
          ? addHeader("### Recent Facts", recentFacts)
          : "",
      recentFactsData,
      relevantFacts:
        relevantFacts && relevantFacts.length > 0
          ? addHeader("### Relevant Facts", relevantFacts)
          : "",
      relevantFactsData,
      attachments:
        formattedAttachments && formattedAttachments.length > 0
          ? addHeader("### Attachments", formattedAttachments)
          : "",
      ...additionalKeys,
    };

    const actionPromises = this.actions.map(async (action: Action) => {
      const result = await action.validate(this, message, initialState);
      if (result) {
        return action;
      }
      return null;
    });

    const evaluatorPromises = this.evaluators.map(async (evaluator) => {
      const result = await evaluator.validate(this, message, initialState);
      if (result) {
        return evaluator;
      }
      return null;
    });

    const [resolvedEvaluators, resolvedActions, providers] = await Promise.all([
      Promise.all(evaluatorPromises),
      Promise.all(actionPromises),
      getProviders(this, message, initialState),
    ]);

    const evaluatorsData = resolvedEvaluators.filter(Boolean) as Evaluator[];
    const actionsData = resolvedActions.filter(Boolean) as Action[];

    const actionState = {
      actionNames: addHeader(
        "### Possible response actions:",
        formatActionNames(actionsData),
      ),
      actionConditions:
        actionsData.length > 0 ? formatActionConditions(actionsData) : "",
      actions: actionsData.length > 0 ? formatActions(actionsData) : "",
      actionExamples:
        actionsData.length > 0
          ? addHeader(
            "### Action Examples",
            composeActionExamples(actionsData, 10),
          )
          : "",
      evaluatorsData,
      evaluators:
        evaluatorsData.length > 0 ? formatEvaluators(evaluatorsData) : "",
      evaluatorNames:
        evaluatorsData.length > 0 ? formatEvaluatorNames(evaluatorsData) : "",
      evaluatorConditions:
        evaluatorsData.length > 0
          ? formatEvaluatorConditions(evaluatorsData)
          : "",
      evaluatorExamples:
        evaluatorsData.length > 0
          ? formatEvaluatorExamples(evaluatorsData)
          : "",
      providers,
    };

    return { ...initialState, ...actionState };
  }

  async updateRecentMessageState(state: State): Promise<State> {
    const conversationLength = this.getConversationLength();
    const recentMessagesData = await this.messageManager.getMemories({
      room_id: state.room_id,
      count: conversationLength,
      unique: false,
    });

    const recentMessages = formatMessages({
      actors: state.actorsData ?? [],
      messages: recentMessagesData.map((memory: Memory) => {
        const newMemory = { ...memory };
        delete newMemory.embedding;
        return newMemory;
      }),
    });

    let allAttachments = state.attachments || [];

    if (recentMessagesData && Array.isArray(recentMessagesData)) {
      const lastMessageWithAttachment = recentMessagesData.find(
        (msg) => msg.content.attachments && msg.content.attachments.length > 0,
      );

      if (lastMessageWithAttachment) {
        const lastMessageTime = lastMessageWithAttachment.created_at.getTime();
        const oneHourBeforeLastMessage = lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

        allAttachments = recentMessagesData
          .filter((msg) => {
            const msgTime = msg.created_at.getTime();
            return (
              msgTime >= oneHourBeforeLastMessage && msgTime <= lastMessageTime
            );
          })
          .flatMap((msg) => msg.content.attachments || []);
      }
    }

    const formattedAttachments = (allAttachments as Media[])
      .map(
        (attachment) =>
          `ID: ${attachment.id}
Name: ${attachment.title}
URL: ${attachment.url} 
Type: ${attachment.source}
Description: ${attachment.description}
Text: ${attachment.text}
    `,
      )
      .join("\n");

    return {
      ...state,
      recentMessages: addHeader("### Conversation Messages", recentMessages),
      recentMessagesData,
      attachments: formattedAttachments,
    };
  }
}