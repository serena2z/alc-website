import { EventEmitter, WebSocket } from 'ws';
import { BaseMessage, AIMessage, HumanMessage } from '@langchain/core/messages';
import handleWebSearch from '../agents/webSearchAgent';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import logger from '../utils/logger';
import crypto from 'crypto';

// In-memory storage
const chatsStore = new Map();
const messagesStore = new Map();

type Message = {
  messageId: string;
  chatId: string;
  content: string;
};

type WSMessage = {
  message: Message;
  copilot: boolean;
  type: string;
  focusMode: string;
  history: Array<[string, string]>;
};

type StoredMessage = {
  content: string;
  chatId: string;
  messageId: string;
  role: 'assistant' | 'user';
  metadata: string;
};

type StoredChat = {
  id: string;
  title: string;
  createdAt: string;
  focusMode: string;
};

const searchHandlers = {
  webSearch: handleWebSearch,
};

const handleEmitterEvents = (
  emitter: EventEmitter,
  ws: WebSocket,
  messageId: string,
  chatId: string,
) => {
  let receivedMessage = '';
  let sources = [];

  emitter.on('data', (data) => {
    const parsedData = JSON.parse(data);
    if (parsedData.type === 'response') {
      ws.send(
        JSON.stringify({
          type: 'message',
          data: parsedData.data,
          messageId: messageId,
        }),
      );
      receivedMessage += parsedData.data;
    } else if (parsedData.type === 'sources') {
      ws.send(
        JSON.stringify({
          type: 'sources',
          data: parsedData.data,
          messageId: messageId,
        }),
      );
      sources = parsedData.data;
    }
  });

  emitter.on('end', () => {
    ws.send(JSON.stringify({ type: 'messageEnd', messageId: messageId }));

    // Store message in-memory instead of database
    const message: StoredMessage = {
      content: receivedMessage,
      chatId: chatId,
      messageId: messageId,
      role: 'assistant',
      metadata: JSON.stringify({
        createdAt: new Date(),
        ...(sources && sources.length > 0 && { sources }),
      }),
    };
    messagesStore.set(messageId, message);
  });

  emitter.on('error', (data) => {
    const parsedData = JSON.parse(data);
    ws.send(
      JSON.stringify({
        type: 'error',
        data: parsedData.data,
        key: 'CHAIN_ERROR',
      }),
    );
  });
};

export const handleMessage = async (
  message: string,
  ws: WebSocket,
  llm: BaseChatModel,
  embeddings: Embeddings,
) => {
  try {
    const parsedWSMessage = JSON.parse(message) as WSMessage;
    const parsedMessage = parsedWSMessage.message;

    const id = crypto.randomBytes(7).toString('hex');

    if (!parsedMessage.content) {
      return ws.send(
        JSON.stringify({
          type: 'error',
          data: 'Invalid message format',
          key: 'INVALID_FORMAT',
        }),
      );
    }

    const history: BaseMessage[] = parsedWSMessage.history.map((msg) => {
      if (msg[0] === 'human') {
        return new HumanMessage({
          content: msg[1],
        });
      } else {
        return new AIMessage({
          content: msg[1],
        });
      }
    });

    if (parsedWSMessage.type === 'message') {
      const handler = searchHandlers[parsedWSMessage.focusMode];

      if (handler) {
        const emitter = handler(
          parsedMessage.content,
          history,
          llm,
          embeddings,
        );

        handleEmitterEvents(emitter, ws, id, parsedMessage.chatId);

        // Check if chat exists in memory
        const chat = chatsStore.get(parsedMessage.chatId);

        if (!chat) {
          // Store new chat in memory
          const newChat: StoredChat = {
            id: parsedMessage.chatId,
            title: parsedMessage.content,
            createdAt: new Date().toString(),
            focusMode: parsedWSMessage.focusMode,
          };
          chatsStore.set(parsedMessage.chatId, newChat);
        }

        // Store user message in memory
        const userMessage: StoredMessage = {
          content: parsedMessage.content,
          chatId: parsedMessage.chatId,
          messageId: id,
          role: 'user',
          metadata: JSON.stringify({
            createdAt: new Date(),
          }),
        };
        messagesStore.set(id, userMessage);

      } else {
        ws.send(
          JSON.stringify({
            type: 'error',
            data: 'Invalid focus mode',
            key: 'INVALID_FOCUS_MODE',
          }),
        );
      }
    }
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'error',
        data: 'Invalid message format',
        key: 'INVALID_FORMAT',
      }),
    );
    logger.error(`Failed to handle message: ${err}`);
  }
};

// Helper functions to access stored data
export const getChat = (chatId: string) => chatsStore.get(chatId);
export const getChatMessages = (chatId: string) => 
  Array.from(messagesStore.values()).filter(msg => msg.chatId === chatId);
export const getAllChats = () => Array.from(chatsStore.values());