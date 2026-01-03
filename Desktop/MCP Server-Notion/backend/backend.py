"""
Notion MCP Agent Backend with Fireworks AI Kimi K2 Model
Enhanced with 256K context window for complex workspace analysis
LangChain 1.2.0 compatible - FIXED with proper session management
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import asyncio
import os
import sys
import traceback
import json
import re

# LangChain 1.2.0 imports
from langchain_core.tools import Tool
from langchain_core.prompts import ChatPromptTemplate
from langchain_fireworks import ChatFireworks
from langchain_core.output_parsers import StrOutputParser

# MCP imports
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

app = FastAPI(title="Notion MCP Agent API")

# ------------------------------
# CORS
# ------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------
# Pydantic Models
# ------------------------------
class ConnectRequest(BaseModel):
    notion_key: str
    fireworks_key: str


class QueryRequest(BaseModel):
    query: str
    notion_key: str
    fireworks_key: str


# ------------------------------
# Root / Health Endpoints
# ------------------------------
@app.get("/")
async def root():
    return {
        "message": "Notion MCP Agent API with Kimi K2",
        "model": "kimi-k2-instruct-0905",
        "context_window": "256K tokens",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "connect": "/api/connect",
            "query": "/api/query"
        }
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy", "message": "Server is running"}


# ------------------------------
# MCP Connection Management
# ------------------------------
async def create_mcp_session(notion_key: str):
    """Create and return MCP session with proper context management"""
    npx_cmd = "npx.cmd" if sys.platform == "win32" else "npx"

    server_params = StdioServerParameters(
        command=npx_cmd,
        args=["-y", "@notionhq/notion-mcp-server"],
        env={**os.environ.copy(), "NOTION_TOKEN": notion_key},
    )

    return server_params


# ------------------------------
# Connect Endpoint
# ------------------------------
@app.post("/api/connect")
async def connect_notion(request: Request):
    try:
        body = await request.json()
        notion_key = body.get("notion_key", "").strip()
        fireworks_key = body.get("fireworks_key", "").strip()

        if not notion_key:
            raise HTTPException(400, "Notion API key required")
        if not fireworks_key:
            raise HTTPException(400, "Fireworks API key required")

        # Test connection with longer timeout
        server_params = await create_mcp_session(notion_key)
        
        async with asyncio.timeout(60):  # 60 second timeout for connection
            async with stdio_client(server_params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tool_names = [tool.name for tool in tools_result.tools]

        return {
            "status": "connected",
            "model": "kimi-k2-instruct-0905",
            "context_window": "256K tokens",
            "tools": tool_names,
        }

    except Exception as e:
        print(traceback.format_exc())
        raise HTTPException(500, f"Connection failed: {str(e)}")


# ------------------------------
# Helper: Extract Complete JSON from Text
# ------------------------------
def extract_complete_json(text: str) -> dict:
    """Extract the first complete JSON object from text"""
    if not text or not isinstance(text, str):
        return None
    
    text = text.strip()
    
    # Try direct JSON parse first (handles simple cases like {} or {"key": "value"})
    if text.startswith('{'):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass  # Continue to extraction logic
    
    # Find JSON between braces
    brace_start = text.find('{')
    if brace_start == -1:
        return None
    
    # Count braces to find complete JSON
    brace_count = 0
    in_string = False
    escape_next = False
    
    for i in range(brace_start, len(text)):
        char = text[i]
        
        if escape_next:
            escape_next = False
            continue
            
        if char == '\\':
            escape_next = True
            continue
            
        if char == '"':
            in_string = not in_string
            continue
            
        if not in_string:
            if char == '{':
                brace_count += 1
            elif char == '}':
                brace_count -= 1
                if brace_count == 0:
                    # Found complete JSON
                    json_str = text[brace_start:i+1]
                    try:
                        return json.loads(json_str)
                    except json.JSONDecodeError as e:
                        print(f"JSON decode error: {e}")
                        print(f"Failed JSON string: {json_str}")
                        return None
    
    return None


# ------------------------------
# Enhanced Agent with Persistent Session - FIXED
# ------------------------------
async def run_agent_with_mcp(query: str, llm, notion_key: str):
    """Run agent with persistent MCP session throughout execution"""
    
    server_params = await create_mcp_session(notion_key)
    
    try:
        async with asyncio.timeout(60):  # 3 minute timeout
            async with stdio_client(server_params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    
                    # Create tools description
                    tools_desc = "\n".join([
                        f"- {tool.name}: {tool.description}"
                        for tool in tools_result.tools
                    ])
                    
                    # System prompt - Escape curly braces for LangChain
                    system_prompt = f"""You are an expert AI assistant with access to Notion workspace tools.

Available tools:
{tools_desc}

CRITICAL INSTRUCTIONS:
1. Use tools ONE TIME ONLY per request
2. Wait for tool results before providing final answer
3. When using a tool, respond with ONLY these two lines:
   TOOL_CALL: exact_tool_name
   TOOL_INPUT: <complete valid JSON on ONE line>

4. The JSON must be COMPLETE and VALID - no partial JSON
5. After tool execution, provide your final answer in plain text

Example:
TOOL_CALL: API-create-a-page
TOOL_INPUT: {{{{"parent": {{{{"type": "page_id", "page_id": "123"}}}}, "properties": {{{{"title": [{{{{"text": {{{{"content": "My Page"}}}}}}}}]}}}}}}}}"""

                    prompt = ChatPromptTemplate.from_messages([
                        ("system", system_prompt),
                        ("user", "{query}")
                    ])
                    
                    chain = prompt | llm | StrOutputParser()
                    
                    max_iterations = 5  # REDUCED from 10 to prevent timeout
                    conversation_history = []
                    tools_used = []
                    
                    for iteration in range(max_iterations):
                        print(f"\n=== Iteration {iteration + 1} ===")
                        
                        # Get LLM response
                        if iteration == 0:
                            response = await asyncio.to_thread(chain.invoke, {"query": query})
                        else:
                            context = "\n\n".join(conversation_history[-4:])  # Last 2 exchanges
                            full_query = f"Previous context:\n{context}\n\nProvide final answer for: {query}"
                            response = await asyncio.to_thread(chain.invoke, {"query": full_query})
                        
                        print(f"LLM Response: {response[:300]}...")
                        conversation_history.append(f"Assistant: {response}")
                        
                        # Check if tool usage is requested
                        if "TOOL_CALL:" in response and "TOOL_INPUT:" in response:
                            try:
                                # Extract tool name
                                tool_match = re.search(r'TOOL_CALL:\s*(\S+)', response)
                                if not tool_match:
                                    print("Could not parse tool name")
                                    continue
                                
                                tool_name = tool_match.group(1).strip()
                                print(f"DEBUG: Extracted tool name: '{tool_name}'")
                                
                                # Extract tool input - get everything after TOOL_INPUT: up to next line break or end
                                input_match = re.search(r'TOOL_INPUT:\s*(.+?)(?:\n|$)', response, re.DOTALL)
                                if not input_match:
                                    print("Could not parse tool input")
                                    continue
                                
                                tool_input_text = input_match.group(1).strip()
                                print(f"DEBUG: Extracted tool input text: '{tool_input_text}'")
                                print(f"DEBUG: Tool input repr: {repr(tool_input_text)}")
                                
                                # Parse JSON - try direct parse first
                                try:
                                    arguments = json.loads(tool_input_text)
                                    print(f"DEBUG: Direct JSON parse successful: {arguments}")
                                except json.JSONDecodeError as e:
                                    print(f"DEBUG: Direct parse failed ({e}), trying extract_complete_json")
                                    arguments = extract_complete_json(tool_input_text)
                                
                                if arguments is None:
                                    print(f"ERROR: Could not parse JSON from: {tool_input_text[:200]}")
                                    # Add error to conversation to help LLM correct itself
                                    conversation_history.append(f"Error: Invalid JSON format. Please provide valid JSON for TOOL_INPUT.")
                                    continue
                                
                                # Find the tool
                                mcp_tool = next((t for t in tools_result.tools if t.name == tool_name), None)
                                
                                if not mcp_tool:
                                    print(f"Tool '{tool_name}' not found")
                                    available_tools = [t.name for t in tools_result.tools]
                                    print(f"Available tools: {available_tools}")
                                    conversation_history.append(f"Error: Tool '{tool_name}' not found. Available tools: {', '.join(available_tools)}")
                                    continue
                                
                                print(f"✓ Executing tool: {tool_name}")
                                print(f"✓ Arguments: {json.dumps(arguments, indent=2)[:300]}")
                                
                                # Execute tool
                                try:
                                    tool_result = await session.call_tool(tool_name, arguments=arguments)
                                    
                                    # Extract result content
                                    if hasattr(tool_result, "content") and tool_result.content:
                                        result_text = "\n".join(
                                            item.text if hasattr(item, "text") else str(item)
                                            for item in tool_result.content
                                        )
                                    else:
                                        result_text = str(tool_result)
                                    
                                    print(f"✓ Tool result: {result_text[:300]}...")
                                    conversation_history.append(f"Tool '{tool_name}' result: {result_text}")
                                    tools_used.append(tool_name)
                                    
                                    # SUCCESS - get final answer in next iteration
                                    continue
                                    
                                except Exception as e:
                                    error_msg = f"Error executing tool {tool_name}: {str(e)}"
                                    print(f"✗ {error_msg}")
                                    traceback.print_exc()
                                    conversation_history.append(error_msg)
                                    
                            except Exception as e:
                                print(f"Error in tool execution block: {e}")
                                traceback.print_exc()
                        
                        # If this iteration had no tool call, return response
                        if iteration > 0 and "TOOL_CALL:" not in response:
                            return {
                                "response": response,
                                "tools_used": list(set(tools_used)),
                                "iterations": iteration + 1
                            }
                    
                    # Return final response after max iterations
                    return {
                        "response": conversation_history[-1].replace("Assistant: ", "") if conversation_history else response,
                        "tools_used": list(set(tools_used)),
                        "iterations": max_iterations
                    }
    
    except asyncio.TimeoutError:
        print("⚠ Operation timed out after 180 seconds")
        raise HTTPException(408, "Request timeout - operation took too long")
    except Exception as e:
        print(f"⚠ Error in run_agent_with_mcp: {e}")
        traceback.print_exc()
        raise


# ------------------------------
# Query Endpoint - With Persistent Session
# ------------------------------
@app.post("/api/query")
async def query_agent(request: Request):
    try:
        body = await request.json()
        notion_key = body.get("notion_key", "").strip()
        fireworks_key = body.get("fireworks_key", "").strip()
        query = body.get("query", "").strip()

        if not query:
            raise HTTPException(400, "Query is required")

        # Fireworks Kimi K2 LLM - Lower temperature for better instruction following
        llm = ChatFireworks(
            model="accounts/fireworks/models/kimi-k2-instruct-0905",
            api_key=fireworks_key,
            temperature=0.3,  # Lower for more deterministic behavior
            max_tokens=4096,
        )

        # Run agent with persistent MCP session
        result = await run_agent_with_mcp(query, llm, notion_key)

        return {
            "response": result["response"],
            "model": "kimi-k2-instruct-0905",
            "tools_used": result.get("tools_used", []),
            "iterations": result.get("iterations", 0)
        }

    except Exception as e:
        print(traceback.format_exc())
        raise HTTPException(500, str(e))


# ------------------------------
# Run server
# ------------------------------
if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


