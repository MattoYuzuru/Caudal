# Caudal

Caudal собирает телеметрию личных VPS и отдаёт одни и те же данные в веб-консоль, DeepSeek и внешние MCP-клиенты. Веб-консоль разработана с нуля на React. Базовые компоненты и токены взяты из Aspect UI.

В первом релизе есть одна учётная запись владельца. Linux-сборщик отправляет CPU, RAM, диск и uptime по исходящему HTTPS. До первого замера нода ожидает подключения. После 90 секунд без замеров последний отчёт отображается как устаревший. История хранит 120 замеров на ноду, до 40 нод.

Идеи, контракты навыков и запусков, разбор MCP, A2UI, A2A, WebMCP, Teleport и Codex Remote Control описаны в [исследовании продукта](docs/product-and-architecture.md).

## Локальный запуск

Требуются Go 1.27.4 и Node.js 24. Владелец задаёт пароль через файл с правами `0600`.

```sh
umask 077
mkdir -p .caudal
test -e .caudal/owner-password || openssl rand -hex 32 > .caudal/owner-password
test -e .caudal/mcp-token || openssl rand -hex 32 > .caudal/mcp-token
npm --prefix web ci
npm --prefix web run build
CAUDAL_OWNER_PASSWORD_FILE=.caudal/owner-password \
  CAUDAL_MCP_TOKEN_FILE=.caudal/mcp-token \
  go run ./cmd/caudal
```

Откройте [локальную консоль](http://127.0.0.1:8080). Для разработки с Vite запустите API с `CAUDAL_ORIGIN=http://127.0.0.1:5173`, затем `npm --prefix web run dev`. В этом режиме браузер и MCP обращаются к origin Vite, а сборщик может отправлять heartbeat на локальный API.

Для DeepSeek можно ввести ключ в панели помощника. Ключ хранится в памяти вкладки и передаётся API Caudal с запросом. Backend отправляет DeepSeek вопрос, имя, регион, возраст сигнала и агрегаты узлов выбранной области. Локально можно запустить сервер с `CAUDAL_DOTENV=.env` для чтения только `DEEPSEEK_API_KEY`, либо передать `DEEPSEEK_API_KEY_FILE` с правами `0600`.

## Linux-сборщик

В веб-консоли зарегистрируйте ноду и сохраните её токен отдельно. Выберите бинарник для amd64 или arm64. На своём хосте сохраните токен в файл с правами `0600` и запустите сборщик.

```sh
CAUDAL_URL=https://your-caudal.example \
  CAUDAL_TOKEN_FILE="$HOME/.config/caudal/token" \
  ./caudal-agent
```

Начальный замер использует два чтения CPU с коротким интервалом. Дальнейшие отчёты отправляются раз в 30 секунд. `CAUDAL_INTERVAL` допускает Go duration от 5 до 60 секунд. Для постоянной работы используйте [systemd unit](ops/caudal-agent.service) и инструкцию в [эксплуатации](ops/README.md). Ротация токена в карточке ноды отзывает старый токен сразу после сохранения.

## MCP

Укажите `https://ваш-домен/mcp` как Streamable HTTP сервер и настройте заголовок `Authorization: Bearer <токен MCP>` через секретное хранилище клиента. MCP-токен задаёт администратор через `CAUDAL_MCP_TOKEN_FILE`. Поддерживаются ревизии `2026-07-28` и `2025-11-25`.

| Операция | Аргументы | Результат |
| --- | --- | --- |
| `caudal_list_fleet` | — | Список нод, свежесть, последний замер |
| `caudal_get_node` | `node_id` | Последняя сводка выбранной ноды |
| `caudal_get_samples` | `node_id` | История выбранной ноды |

MCP видит весь каталог единственного владельца и имеет права чтения. Регистрация и ротация требуют веб-сессии. Сборщик может отправлять данные только под выданным ему токеном. Доступ из ChatGPT через OAuth, учётные данные SSH и выполнение задач входят в дорожную карту.

## Проверки и доставка

```sh
go vet ./cmd/... ./internal/...
go test -race -coverprofile=coverage.out ./cmd/... ./internal/...
go tool cover -func=coverage.out
npm --prefix web run check
npm --prefix web test
npm --prefix web exec -- playwright install chromium
npm --prefix web run test:e2e
npm --prefix web run build
```

GitHub Actions проверяет Go и веб, требует не менее 70% покрытия Go-кода, собирает архив с контрольными суммами и прогоняет вход, Linux heartbeat, историю и MCP на собранных бинарниках. Продвижение готового архива на HTTPS-хост описано в [эксплуатации](ops/README.md).
