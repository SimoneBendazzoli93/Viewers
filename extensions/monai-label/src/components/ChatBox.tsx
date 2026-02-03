/*
Copyright (c) MONAI Consortium
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, { Component } from 'react';
import PropTypes from 'prop-types';
import './ChatBox.css';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatBoxProps {
  onSendMessage: (message: string) => Promise<string>;
  placeholder?: string;
  title?: string;
  /** Initial greeting from the assistant (e.g. "Hello, I am your MAIA Radiology Assistant. How can I help you today?") */
  initialAssistantMessage?: string;
}

const DEFAULT_INITIAL_MESSAGE =
  'Hello, I am your MAIA Radiology Assistant. How can I help you today?';

interface ChatBoxState {
  messages: ChatMessage[];
  inputValue: string;
  loading: boolean;
}

export default class ChatBox extends Component<ChatBoxProps, ChatBoxState> {
  static propTypes = {
    onSendMessage: PropTypes.func.isRequired,
    placeholder: PropTypes.string,
    title: PropTypes.string,
    initialAssistantMessage: PropTypes.string,
  };

  static defaultProps = {
    placeholder: 'Type a message...',
    title: 'Chat with MAIA Radiology Assistant',
    initialAssistantMessage: DEFAULT_INITIAL_MESSAGE,
  };

  messagesEndRef: React.RefObject<HTMLDivElement>;

  constructor(props: ChatBoxProps) {
    super(props);
    const initialMessage =
      props.initialAssistantMessage ?? DEFAULT_INITIAL_MESSAGE;
    this.state = {
      messages: initialMessage
        ? [{ role: 'assistant', content: initialMessage }]
        : [],
      inputValue: '',
      loading: false,
    };
    this.messagesEndRef = React.createRef();
  }

  componentDidUpdate() {
    this.messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    this.setState({ inputValue: e.target.value });
  };

  handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  };

  handleSend = async () => {
    const { inputValue } = this.state;
    const trimmed = inputValue.trim();
    if (!trimmed || this.state.loading) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    this.setState({
      messages: [...this.state.messages, userMessage],
      inputValue: '',
      loading: true,
    });

    try {
      const reply = await this.props.onSendMessage(trimmed);
      const assistantMessage: ChatMessage = { role: 'assistant', content: reply };
      this.setState((prev) => ({
        messages: [...prev.messages, assistantMessage],
        loading: false,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to get reply';
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: `Error: ${errMsg}`,
      };
      this.setState((prev) => ({
        messages: [...prev.messages, assistantMessage],
        loading: false,
      }));
    }
  };

  render() {
    const { messages, inputValue, loading } = this.state;
    const { placeholder, title } = this.props;

    return (
      <div className="monaiChatBox">
        <div className="monaiChatBox-title">{title}</div>
        <div className="monaiChatBox-messages">
          {messages.length === 0 && (
            <div className="monaiChatBox-messagesEmpty">
              Send a message to start the conversation.
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`monaiChatBox-message monaiChatBox-message--${msg.role}`}
            >
              <span className="monaiChatBox-messageRole">
                {msg.role === 'user' ? 'You' : 'Assistant'}:
              </span>
              <div className="monaiChatBox-messageContent">{msg.content}</div>
            </div>
          ))}
          {loading && (
            <div className="monaiChatBox-message monaiChatBox-message--assistant">
              <span className="monaiChatBox-messageRole">Assistant:</span>
              <div className="monaiChatBox-messageContent monaiChatBox-typing">
                ...
              </div>
            </div>
          )}
          <div ref={this.messagesEndRef} />
        </div>
        <div className="monaiChatBox-inputRow">
          <textarea
            className="monaiChatBox-input"
            value={inputValue}
            onChange={this.handleInputChange}
            onKeyDown={this.handleKeyDown}
            placeholder={placeholder}
            rows={2}
            disabled={loading}
          />
          <button
            type="button"
            className="monaiChatBox-send actionButton"
            onClick={this.handleSend}
            disabled={loading || !inputValue.trim()}
          >
            Send
          </button>
        </div>
      </div>
    );
  }
}
