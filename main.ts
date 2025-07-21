// main.ts - Deno Grok代理服务 (修复版)
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

interface AccountConfig {
  cookies: string;
  userAgent?: string;
}

// 账号配置 - 部署时通过环境变量设置
const ACCOUNTS: Record<string, AccountConfig> = {
  account1: {
    cookies: Deno.env.get("ACCOUNT1_COOKIES") || "",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  },
  account2: {
    cookies: Deno.env.get("ACCOUNT2_COOKIES") || "",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  },
  account3: {
    cookies: Deno.env.get("ACCOUNT3_COOKIES") || "",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  }
};

// CORS头部
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-account-id",
};

// 处理CORS预检请求
function handleCORS(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }
  return null;
}

// 测试账号连接
async function testAccount(accountId: string): Promise<{ success: boolean; message: string }> {
  try {
    const account = ACCOUNTS[accountId];
    if (!account || !account.cookies) {
      return { 
        success: false, 
        message: `Account ${accountId} not configured or missing cookies` 
      };
    }

    const testUrl = "https://grok.x.ai/";
    
    const response = await fetch(testUrl, {
      method: "HEAD",
      headers: {
        "Cookie": account.cookies,
        "User-Agent": account.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "manual",
    });

    if (response.status === 200 || response.status === 302) {
      return { success: true, message: "Connection test successful" };
    } else if (response.status === 401 || response.status === 403) {
      return { success: false, message: "Authentication failed - cookies may be invalid" };
    } else {
      return { success: false, message: `HTTP ${response.status}` };
    }
  } catch (error) {
    return { 
      success: false, 
      message: `Connection failed: ${error.message}` 
    };
  }
}

// 代理Grok请求
async function proxyGrokRequest(request: Request, accountId: string): Promise<Response> {
  try {
    const account = ACCOUNTS[accountId];
    if (!account || !account.cookies) {
      return new Response(
        JSON.stringify({ error: `Account ${accountId} not configured or missing cookies` }),
        { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    const url = new URL(request.url);
    let targetPath = url.searchParams.get("path") || "/";
    
    // 确保路径以 / 开头
    if (!targetPath.startsWith("/")) {
      targetPath = "/" + targetPath;
    }
    
    const grokUrl = `https://grok.x.ai${targetPath}`;

    console.log(`Proxying request to: ${grokUrl} for account: ${accountId}`);

    // 构建请求头
    const headers: HeadersInit = {
      "Cookie": account.cookies,
      "User-Agent": account.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": request.headers.get("Accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      "DNT": "1",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Cache-Control": "max-age=0",
    };

    // 如果是POST请求，复制请求体和相关头部
    let body = undefined;
    if (request.method === "POST") {
      body = await request.text();
      headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
      headers["Content-Length"] = body.length.toString();
    }

    const response = await fetch(grokUrl, {
      method: request.method,
      headers,
      body,
      redirect: "follow", // 自动处理重定向
    });

    // 获取响应内容
    let responseBody = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "";

    // 如果是HTML内容，需要修改其中的链接
    if (contentType.includes("text/html")) {
      let htmlContent = new TextDecoder().decode(responseBody);
      
      // 获取当前主机名
      const currentHost = new URL(request.url).origin;
      
      // 替换页面中的链接，让它们通过代理
      htmlContent = htmlContent
        // 替换相对路径的链接
        .replace(/href="\/([^"]*?)"/g, `href="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/src="\/([^"]*?)"/g, `src="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/action="\/([^"]*?)"/g, `action="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        // 替换CSS中的相对路径
        .replace(/url\(\/([^)]+)\)/g, `url(${currentHost}/proxy?account=${accountId}&path=/$1)`)
        .replace(/url\("\/([^"]+)"\)/g, `url("${currentHost}/proxy?account=${accountId}&path=/$1")`)
        .replace(/url\('\/([^']+)'\)/g, `url('${currentHost}/proxy?account=${accountId}&path=/$1')`)
        // 添加账号标识
        .replace(
          "<head>",
          `<head>
          <style>
            .proxy-account-indicator {
              position: fixed !important;
              top: 10px !important;
              right: 10px !important;
              background: rgba(29, 155, 240, 0.9) !important;
              color: white !important;
              padding: 6px 12px !important;
              border-radius: 6px !important;
              font-size: 12px !important;
              z-index: 999999 !important;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
              font-weight: 500 !important;
              box-shadow: 0 2px 8px rgba(0,0,0,0.2) !important;
            }
          </style>
          <div class="proxy-account-indicator">🤖 ${accountId.toUpperCase()}</div>`
        );
      
      responseBody = new TextEncoder().encode(htmlContent).buffer;
    }

    // 构建响应头
    const responseHeaders = new Headers(corsHeaders);
    
    // 复制重要的响应头
    const headersToKeep = [
      "Content-Type", "Cache-Control", "Expires", 
      "Last-Modified", "ETag", "Content-Encoding"
    ];
    
    headersToKeep.forEach(headerName => {
      const headerValue = response.headers.get(headerName);
      if (headerValue) {
        responseHeaders.set(headerName, headerValue);
      }
    });

    // 设置正确的 Content-Length
    responseHeaders.set("Content-Length", responseBody.byteLength.toString());

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(
      JSON.stringify({ 
        error: "Proxy request failed", 
        details: error.message,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
}

// 静态文件服务
async function serveStaticFile(pathname: string): Promise<Response> {
  try {
    // 默认服务 index.html
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }
    
    // 安全检查：防止目录遍历
    if (pathname.includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }
    
    // 尝试从 public 目录读取文件
    const filePath = `./public${pathname}`;
    
    try {
      const fileContent = await Deno.readFile(filePath);
      
      // 确定内容类型
      let contentType = "text/plain";
      if (pathname.endsWith(".html")) contentType = "text/html";
      else if (pathname.endsWith(".css")) contentType = "text/css";
      else if (pathname.endsWith(".js")) contentType = "application/javascript";
      else if (pathname.endsWith(".json")) contentType = "application/json";
      else if (pathname.endsWith(".png")) contentType = "image/png";
      else if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) contentType = "image/jpeg";
      else if (pathname.endsWith(".gif")) contentType = "image/gif";
      else if (pathname.endsWith(".svg")) contentType = "image/svg+xml";
      
      return new Response(fileContent, {
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return new Response("File not found", { 
        status: 404,
        headers: corsHeaders,
      });
    }
  } catch (error) {
    return new Response("Server error", { 
      status: 500,
      headers: corsHeaders,
    });
  }
}

// 主请求处理器
async function handler(request: Request): Promise<Response> {
  // 处理CORS
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const url = new URL(request.url);
  const pathname = url.pathname;

  console.log(`${request.method} ${pathname}`);

  // API路由
  if (pathname.startsWith("/api/")) {
    const apiPath = pathname.replace("/api", "");
    
    switch (apiPath) {
      case "/accounts":
        // 返回可用账号列表
        const availableAccounts = Object.keys(ACCOUNTS).filter(
          key => ACCOUNTS[key].cookies
        );
        return new Response(
          JSON.stringify({ accounts: availableAccounts }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      case "/health":
        return new Response(
          JSON.stringify({ 
            status: "ok", 
            timestamp: new Date().toISOString(),
            accounts: Object.keys(ACCOUNTS).reduce((acc, key) => {
              acc[key] = { configured: !!ACCOUNTS[key].cookies };
              return acc;
            }, {} as Record<string, { configured: boolean }>)
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      default:
        // 检查是否是测试账号的请求
        const testMatch = apiPath.match(/^\/test\/(.+)$/);
        if (testMatch) {
          const accountId = testMatch[1];
          const testResult = await testAccount(accountId);
          return new Response(
            JSON.stringify(testResult),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        return new Response(
          JSON.stringify({ error: "API endpoint not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  }

  // 代理路由
  if (pathname === "/proxy") {
    const accountId = url.searchParams.get("account") || "account1";
    return await proxyGrokRequest(request, accountId);
  }

  // 直接账号访问路由
  if (pathname.startsWith("/account")) {
    const accountId = pathname.substring(1); // 移除开头的 '/'
    if (ACCOUNTS[accountId]) {
      // 重定向到Grok主页，通过代理
      const grokMainUrl = `/proxy?account=${accountId}&path=/`;
      return Response.redirect(new URL(grokMainUrl, request.url).href, 302);
    }
  }

  // 静态文件服务
  return await serveStaticFile(pathname);
}

// 启动服务器
const port = parseInt(Deno.env.get("PORT") || "8000");

console.log(`🚀 Grok代理服务启动在端口 ${port}`);
console.log(`📁 静态文件目录: ./public`);
console.log(`🔐 已配置账号: ${Object.keys(ACCOUNTS).filter(k => ACCOUNTS[k].cookies).join(", ")}`);

await serve(handler, { port });