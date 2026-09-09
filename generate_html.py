import json

train_outward = [
    ["06:01", "06:08"], ["06:19", "06:27"], ["06:58", "07:05"], ["07:19", "07:27"], ["07:41", "07:50"], ["08:04", "08:12"], ["08:23", "08:30"], ["09:01", "09:09"], ["09:31", "09:38"], ["10:14", "10:21"], ["10:52", "11:00"], ["11:40", "11:48"], ["12:29", "12:37"], ["13:01", "13:09"], ["13:39", "13:46"], ["14:16", "14:24"], ["14:47", "14:55"], ["15:26", "15:33"], ["16:05", "16:13"], ["16:25", "16:33"], ["16:45", "16:53"], ["17:04", "17:12"], ["17:43", "17:51"], ["18:04", "18:12"], ["18:26", "18:34"], ["19:05", "19:13"], ["19:25", "19:33"], ["20:05", "20:14"], ["20:45", "20:52"], ["21:24", "21:31"], ["22:16", "22:23"], ["22:55", "23:02"]
]
bus_outward = [
    ["07:55", "08:07"], ["08:15", "08:27"], ["08:45", "08:57"], ["09:15", "09:26"], ["09:45", "09:56"], ["10:45", "10:56"], ["11:45", "11:56"], ["12:45", "12:56"], ["13:45", "13:56"], ["14:45", "14:56"], ["15:45", "15:56"], ["16:15", "16:27"], ["16:50", "17:03"], ["17:10", "17:24"], ["17:40", "17:55"], ["18:15", "18:30"], ["18:55", "19:07"], ["19:20", "19:32"], ["20:00", "20:11"], ["20:55", "21:03"], ["21:55", "22:03"]
]
jr_outward = [
    ["05:29", "05:33"], ["06:07", "06:11"], ["06:26", "06:31"], ["06:55", "06:59"], ["07:10", "07:14"], ["07:26", "07:30"], ["07:47", "07:51"], ["07:53", "07:57"], ["08:03", "08:07"], ["08:21", "08:25"], ["08:38", "08:42"], ["08:54", "08:59"], ["09:08", "09:12"], ["09:17", "09:22"], ["09:43", "09:47"], ["10:08", "10:12"], ["10:18", "10:22"], ["10:40", "10:45"], ["11:19", "11:23"], ["11:55", "11:59"], ["12:10", "12:14"], ["12:21", "12:26"], ["12:46", "12:50"], ["13:06", "13:10"], ["13:17", "13:21"], ["13:47", "13:51"], ["14:09", "14:13"], ["15:08", "15:12"], ["15:22", "15:26"], ["15:48", "15:52"], ["16:09", "16:13"], ["16:29", "16:33"], ["16:43", "16:47"], ["17:06", "17:11"], ["17:16", "17:21"], ["17:34", "17:38"], ["17:52", "17:56"], ["18:13", "18:17"], ["18:35", "18:39"], ["18:53", "18:57"], ["19:15", "19:19"], ["19:30", "19:35"], ["19:45", "19:50"], ["20:01", "20:05"], ["20:12", "20:16"], ["20:44", "20:48"], ["21:08", "21:12"], ["21:25", "21:29"], ["21:44", "21:48"], ["22:13", "22:17"], ["22:36", "22:40"], ["23:03", "23:07"], ["23:47", "23:51"]
]

train_return = [
    ["05:42", "05:49"], ["06:08", "06:15"], ["06:46", "06:53"], ["07:05", "07:12"], ["07:26", "07:34"], ["07:49", "07:56"], ["08:11", "08:18"], ["08:49", "08:56"], ["09:08", "09:15"], ["09:57", "10:04"], ["10:40", "10:47"], ["11:20", "11:28"], ["12:07", "12:14"], ["12:37", "12:44"], ["13:09", "13:17"], ["13:47", "13:54"], ["14:24", "14:31"], ["15:14", "15:21"], ["15:53", "16:01"], ["16:12", "16:20"], ["16:33", "16:40"], ["16:52", "16:59"], ["17:30", "17:38"], ["17:51", "17:58"], ["18:11", "18:19"], ["18:34", "18:41"], ["19:13", "19:20"], ["19:51", "19:58"], ["20:32", "20:40"], ["21:12", "21:19"], ["21:51", "21:58"], ["22:23", "22:30"]
]
bus_return = [
    ["06:17", "06:29"], ["06:48", "07:02"], ["07:10", "07:27"], ["07:30", "07:47"], ["08:11", "08:30"], ["09:05", "09:21"], ["09:48", "10:04"], ["10:18", "10:34"], ["10:48", "11:04"], ["11:48", "12:04"], ["12:48", "13:04"], ["13:48", "14:04"], ["14:48", "15:04"], ["15:48", "16:04"], ["16:48", "17:04"], ["17:54", "18:14"], ["18:24", "18:44"], ["18:52", "19:09"], ["19:48", "20:02"], ["20:57", "21:09"]
]
jr_return = [
    ["05:56", "06:00"], ["06:12", "06:16"], ["06:31", "06:35"], ["07:01", "07:04"], ["07:14", "07:17"], ["07:34", "07:38"], ["07:52", "07:55"], ["08:15", "08:18"], ["08:43", "08:47"], ["08:58", "09:02"], ["09:21", "09:24"], ["09:48", "09:51"], ["10:03", "10:06"], ["10:33", "10:36"], ["11:21", "11:24"], ["11:47", "11:50"], ["12:04", "12:07"], ["12:21", "12:25"], ["12:48", "12:52"], ["13:10", "13:14"], ["13:42", "13:46"], ["14:07", "14:11"], ["14:23", "14:27"], ["14:44", "14:48"], ["15:06", "15:10"], ["15:21", "15:25"], ["15:40", "15:43"], ["15:54", "15:58"], ["16:12", "16:16"], ["16:26", "16:30"], ["16:42", "16:46"], ["17:06", "17:10"], ["17:21", "17:24"], ["17:40", "17:43"], ["17:58", "18:02"], ["18:16", "18:19"], ["18:34", "18:38"], ["18:46", "18:49"], ["18:57", "19:01"], ["19:13", "19:17"], ["19:40", "19:43"], ["19:53", "19:57"], ["20:01", "20:04"], ["20:16", "20:20"], ["20:38", "20:41"], ["20:55", "20:59"], ["21:17", "21:21"], ["21:47", "21:51"], ["22:11", "22:14"], ["22:36", "22:40"], ["23:09", "23:12"], ["23:51", "23:55"]
]

html_template = f"""<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>倉敷駅周辺〜西富井・穴場神社前・西阿知 ダイヤ比較表</title>
    
    <!-- PWA用設定 -->
    <link rel="manifest" href="./manifest.json">
    <meta name="theme-color" content="#2c3e50">
    <link rel="apple-touch-icon" href="./icon.svg">

    <style>
        body {{
            font-family: 'Hiragino Kaku Gothic ProN', 'Meiryo', sans-serif;
            margin: 0;
            padding: 10px;
            background-color: #f4f7f6;
            color: #333;
            font-size: 18px; /* スマホ向けに大きく */
        }}
        h1 {{
            text-align: center;
            font-size: 24px; /* スマホ向けに大きく */
            color: #2c3e50;
            line-height: 1.3;
            margin-top: 10px;
        }}
        
        /* タブのスタイル */
        .tabs {{
            display: flex;
            justify-content: center;
            margin-bottom: 20px;
            border-bottom: 2px solid #ddd;
        }}
        .tab-btn {{
            background: #f8f9fa;
            border: none;
            padding: 15px 20px;
            font-size: 18px;
            font-weight: bold;
            cursor: pointer;
            color: #666;
            flex: 1;
            max-width: 250px;
            transition: 0.3s;
            border-radius: 8px 8px 0 0;
            margin: 0 5px;
        }}
        .tab-btn.active {{
            background: #2c3e50;
            color: #fff;
        }}
        .tab-content {{
            display: none;
        }}
        .tab-content.active {{
            display: block;
        }}

        .container {{
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 20px;
            margin-top: 20px;
        }}
        .timetable {{
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            padding: 15px;
            width: 100%;
            max-width: 100%; /* スマホ幅いっぱい */
        }}
        .timetable h2 {{
            font-size: 20px; /* 大きく */
            text-align: center;
            margin-top: 0;
            padding-bottom: 10px;
            border-bottom: 2px solid #ddd;
        }}
        .railway h2 {{ color: #2980b9; border-bottom-color: #2980b9; }}
        .bus h2 {{ color: #27ae60; border-bottom-color: #27ae60; }}
        .jr-sanyo h2 {{ color: #8e44ad; border-bottom-color: #8e44ad; }}
        
        .table-wrap {{
            max-height: 45vh; /* 画面高さに合わせてスクロール */
            overflow-y: auto;
            border-bottom: 1px solid #ddd;
            margin-top: 10px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            margin-top: 0;
        }}
        th, td {{
            padding: 15px 5px; /* タップしやすく縦に大きく */
            text-align: center;
            border-bottom: 1px solid #eee;
            font-size: 20px; /* 時刻の文字を大きく */
        }}
        th {{
            background-color: #f8f9fa;
            font-weight: bold;
            font-size: 16px;
            position: sticky;
            top: 0;
            z-index: 1;
            box-shadow: 0 2px 2px -1px rgba(0, 0, 0, 0.1);
        }}
        tr:hover {{
            background-color: #f1f1f1;
        }}
        .note {{
            font-size: 14px; /* 大きく */
            color: #666;
            margin-top: 15px;
            line-height: 1.5;
        }}
        
        /* 検索ボックスのスタイルもスマホ向けに大きく */
        .search-box {{
            text-align: center; 
            margin: 15px 0; 
            padding: 20px 10px; 
            background: #fff; 
            border-radius: 8px; 
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }}
        .search-box label {{ font-size: 18px; font-weight: bold; display: block; margin-bottom: 10px; }}
        .search-box input[type="time"] {{ font-size: 24px; padding: 10px; width: 80%; max-width: 200px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 4px; text-align: center; }}
        .search-box button {{ font-size: 20px; padding: 15px; width: 100%; max-width: 300px; background-color: #34495e; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }}
        .resultBox {{ margin-top: 20px; font-size: 20px; font-weight: bold; min-height: 2em; line-height: 1.4; }}
    </style>
</head>
<body>

    <h1>倉敷駅周辺 〜 西富井・穴場神社前・西阿知 ダイヤ</h1>

    <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('outward')">行き<br><small>(西阿知→倉敷→各所)</small></button>
        <button class="tab-btn" onclick="switchTab('return')">帰り<br><small>(各所→倉敷→西阿知)</small></button>
    </div>

    <!-- 行き（OUTWARD） -->
    <div id="outward" class="tab-content active">
        <div class="search-box">
            <label for="timeInputOutward">西阿知駅の出発予定時刻:</label>
            <input type="time" id="timeInputOutward">
            <button onclick="findNextRideOutward()">どちらに乗るべきか検索</button>
            <div id="resultBoxOutward" class="resultBox"></div>
        </div>

        <div class="container">
            <!-- JR山陽本線 -->
            <div class="timetable jr-sanyo">
                <h2>JR山陽本線（上り）<br><small>西阿知駅 → 倉敷駅</small></h2>
                <div class="table-wrap">
                    <table id="jr-table-outward">
                        <thead>
                            <tr>
                                <th>西阿知駅 発</th>
                                <th>倉敷駅 着</th>
                            </tr>
                        </thead>
                        <tbody>
                            {''.join([f"<tr><td>{row[0]}</td><td>{row[1]}</td></tr>" for row in jr_outward])}
                        </tbody>
                    </table>
                </div>
                <div class="note">
                    ※JR山陽本線の時刻はNAVITIMEのスクリーンショットに基づいています。<br>
                    ※所要時間は約4〜5分です。
                </div>
            </div>

            <!-- 水島臨海鉄道 -->
            <div class="timetable railway">
                <h2>水島臨海鉄道（下り）<br><small>倉敷市駅 → 西富井駅</small></h2>
                <div class="table-wrap">
                    <table id="railway-table-outward">
                        <thead>
                            <tr>
                                <th>倉敷市駅 発</th>
                                <th>西富井駅 着</th>
                            </tr>
                        </thead>
                        <tbody>
                            {''.join([f"<tr><td>{row[0]}</td><td>{row[1]}</td></tr>" for row in train_outward])}
                        </tbody>
                    </table>
                </div>
                <div class="note">
                    ※水島臨海鉄道公式標準時刻表（下り）に基づいています。所要時間は約7〜8分です。
                </div>
            </div>

            <!-- 両備バス -->
            <div class="timetable bus">
                <h2>両備バス（小溝線）<br><small>倉敷駅前 → 穴場神社前</small></h2>
                <div class="table-wrap">
                    <table id="bus-table-outward">
                        <thead>
                            <tr>
                                <th>倉敷駅前 発</th>
                                <th>穴場神社前 着</th>
                            </tr>
                        </thead>
                        <tbody>
                            {''.join([f"<tr><td>{row[0]}</td><td>{row[1]}</td></tr>" for row in bus_outward])}
                        </tbody>
                    </table>
                </div>
                <div class="note">
                    ※両備バスの時刻はご提供いただいたNAVITIMEのスクリーンショット（倉敷小溝車庫線）に基づいています。<br>
                    ※所要時間は交通状況により約8分〜15分程度です。運賃は片道210円。
                </div>
            </div>
        </div>
    </div>

    <!-- 帰り（RETURN） -->
    <div id="return" class="tab-content">
        <div class="search-box">
            <label for="timeInputReturn">出発予定時刻 (西富井/穴場神社前):</label>
            <input type="time" id="timeInputReturn">
            <button onclick="findNextRideReturn()">どちらに乗るべきか検索</button>
            <div id="resultBoxReturn" class="resultBox"></div>
        </div>

        <div class="container">
            <!-- 水島臨海鉄道 -->
            <div class="timetable railway">
                <h2>水島臨海鉄道（上り）<br><small>西富井駅 → 倉敷市駅</small></h2>
                <div class="table-wrap">
                    <table id="railway-table-return">
                        <thead>
                            <tr>
                                <th>西富井駅 発</th>
                                <th>倉敷市駅 着</th>
                            </tr>
                        </thead>
                        <tbody>
                            {''.join([f"<tr><td>{row[0]}</td><td>{row[1]}</td></tr>" for row in train_return])}
                        </tbody>
                    </table>
                </div>
                <div class="note">
                    ※水島臨海鉄道の時刻はNAVITIMEのスクリーンショットに基づいています。<br>
                    ※所要時間は約7分です。
                </div>
            </div>

            <!-- 両備バス -->
            <div class="timetable bus">
                <h2>両備バス（小溝線）<br><small>穴場神社前 → 倉敷駅前</small></h2>
                <div class="table-wrap">
                    <table id="bus-table-return">
                        <thead>
                            <tr>
                                <th>穴場神社前 発</th>
                                <th>倉敷駅前 着</th>
                            </tr>
                        </thead>
                        <tbody>
                            {''.join([f"<tr><td>{row[0]}</td><td>{row[1]}</td></tr>" for row in bus_return])}
                        </tbody>
                    </table>
                </div>
                <div class="note">
                    ※両備バスの時刻はNAVITIMEのスクリーンショットに基づいています。<br>
                    ※所要時間は交通状況により約12〜20分程度です。
                </div>
            </div>

            <!-- JR山陽本線 -->
            <div class="timetable jr-sanyo">
                <h2>JR山陽本線（下り）<br><small>倉敷駅 → 西阿知駅</small></h2>
                <div class="table-wrap">
                    <table id="jr-table-return">
                        <thead>
                            <tr>
                                <th>倉敷駅 発</th>
                                <th>西阿知駅 着</th>
                            </tr>
                        </thead>
                        <tbody>
                            {''.join([f"<tr><td>{row[0]}</td><td>{row[1]}</td></tr>" for row in jr_return])}
                        </tbody>
                    </table>
                </div>
                <div class="note">
                    ※JR山陽本線の時刻はNAVITIMEのスクリーンショットに基づいています。<br>
                    ※所要時間は約3〜4分です。
                </div>
            </div>
        </div>
    </div>

    <script>
        if ('serviceWorker' in navigator) {{
            window.addEventListener('load', () => {{
                navigator.serviceWorker.register('./sw.js', {{ scope: './' }}).then(registration => {{
                    console.log('ServiceWorker registration successful');
                }}).catch(err => {{
                    console.log('ServiceWorker registration failed: ', err);
                }});
            }});
        }}

        function switchTab(tabId) {{
            // Remove active class from all tabs and contents
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            // Add active class to clicked tab and corresponding content
            if(tabId === 'outward') {{
                document.querySelectorAll('.tab-btn')[0].classList.add('active');
            }} else {{
                document.querySelectorAll('.tab-btn')[1].classList.add('active');
            }}
            document.getElementById(tabId).classList.add('active');
        }}

        function parseTime(timeStr) {{
            if (!timeStr) return null;
            const [hours, minutes] = timeStr.split(':').map(Number);
            return hours * 60 + minutes;
        }}

        function getNextRide(tableId, inputTimeMinutes) {{
            const rows = document.querySelectorAll('#' + tableId + ' tbody tr');
            for (let row of rows) {{
                const depTimeStr = row.cells[0].innerText.trim();
                const arrTimeStr = row.cells[1].innerText.trim();
                const depTimeMins = parseTime(depTimeStr);
                
                if (depTimeMins >= inputTimeMinutes) {{
                    return {{
                        departure: depTimeStr,
                        departureMins: depTimeMins,
                        arrival: arrTimeStr,
                        arrivalMins: parseTime(arrTimeStr),
                        element: row
                    }};
                }}
            }}
            return null;
        }}

        function formatTime() {{
            const now = new Date();
            now.setMinutes(now.getMinutes() + 20);
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            document.getElementById('timeInputOutward').value = `${{hours}}:${{minutes}}`;
            document.getElementById('timeInputReturn').value = `${{hours}}:${{minutes}}`;
        }}

        function scrollRowToCenter(row) {{
            const wrap = row.closest('.table-wrap');
            if (wrap) {{
                wrap.scrollTo({{
                    top: row.offsetTop - (wrap.clientHeight / 2) + (row.clientHeight / 2),
                    behavior: 'smooth'
                }});
            }}
        }}

        function resetHighlights(tabId) {{
            document.querySelectorAll(`#${{tabId}} tr`).forEach(tr => tr.style.backgroundColor = '');
        }}

        function findNextRideOutward() {{
            resetHighlights('outward');
            const timeInput = document.getElementById('timeInputOutward').value;
            if (!timeInput) {{ alert('時刻を入力してください'); return; }}
            const inputTimeMinutes = parseTime(timeInput);
            
            const nextJR = getNextRide('jr-table-outward', inputTimeMinutes);
            const resultBox = document.getElementById('resultBoxOutward');

            if (!nextJR) {{
                resultBox.innerHTML = '<span style="color: red;">本日のJR線の運行は終了しました。</span>';
                return;
            }}

            scrollRowToCenter(nextJR.element);
            const TRANSFER_TIME = 5;
            const kurashikiDepMins = nextJR.arrivalMins + TRANSFER_TIME;

            const nextTrain = getNextRide('railway-table-outward', kurashikiDepMins);
            const nextBus = getNextRide('bus-table-outward', kurashikiDepMins);

            if (nextTrain) scrollRowToCenter(nextTrain.element);
            if (nextBus) scrollRowToCenter(nextBus.element);

            const options = [];
            if (nextTrain) options.push({{ type: 'train', name: '水島臨海鉄道 (西富井行)', color: '#2980b9', bgColor: '#d6eaf8', route: `${{nextTrain.departure}}発 → ${{nextTrain.arrival}}着`, data: nextTrain }});
            if (nextBus) options.push({{ type: 'bus', name: '両備バス (穴場神社前行)', color: '#27ae60', bgColor: '#d5f5e3', route: `${{nextBus.departure}}発 → ${{nextBus.arrival}}着`, data: nextBus }});

            if (options.length === 0) {{
                resultBox.innerHTML = `<span style="color: #8e44ad;">JR (${{nextJR.departure}}発→${{nextJR.arrival}}着)</span> に乗車できますが、倉敷からの接続便は終了しています。`;
                nextJR.element.style.backgroundColor = '#ebdef0';
                return;
            }}

            options.sort((a, b) => {{
                if (a.data.arrivalMins !== b.data.arrivalMins) return a.data.arrivalMins - b.data.arrivalMins;
                return b.data.departureMins - a.data.departureMins;
            }});

            const best = options[0];
            const tied = options.filter(opt => opt.data.arrivalMins === best.data.arrivalMins && opt.data.departureMins === best.data.departureMins);

            let recommendation = `行き: 西阿知 ${{nextJR.departure}}発 → 倉敷 ${{nextJR.arrival}}着<br>`;
            if (tied.length === 1) {{
                recommendation += `おすすめ: <span style="color: ${{best.color}};">${{best.name}}</span> (${{best.route}})`;
                best.data.element.style.backgroundColor = best.bgColor;
            }} else {{
                recommendation += `おすすめ: 倉敷からどちらでも同じ時刻に到着します<br>`;
                recommendation += tied.map(opt => `<span style="color: ${{opt.color}};">${{opt.name}}</span> (${{opt.route}})`).join(' / ');
                tied.forEach(opt => opt.data.element.style.backgroundColor = opt.bgColor);
            }}
            nextJR.element.style.backgroundColor = '#ebdef0';
            resultBox.innerHTML = recommendation;
        }}

        function findNextRideReturn() {{
            resetHighlights('return');
            const timeInput = document.getElementById('timeInputReturn').value;
            if (!timeInput) {{ alert('時刻を入力してください'); return; }}
            const inputTimeMinutes = parseTime(timeInput);
            
            const nextTrain = getNextRide('railway-table-return', inputTimeMinutes);
            const nextBus = getNextRide('bus-table-return', inputTimeMinutes);
            const resultBox = document.getElementById('resultBoxReturn');

            if (!nextTrain && !nextBus) {{
                resultBox.innerHTML = '<span style="color: red;">本日の倉敷方面への運行は終了しました。</span>';
                return;
            }}

            if (nextTrain) scrollRowToCenter(nextTrain.element);
            if (nextBus) scrollRowToCenter(nextBus.element);

            const options = [];
            if (nextTrain) options.push({{ type: 'train', name: '水島臨海鉄道 (西富井発)', color: '#2980b9', bgColor: '#d6eaf8', arrivalMins: nextTrain.arrivalMins, data: nextTrain }});
            if (nextBus) options.push({{ type: 'bus', name: '両備バス (穴場神社前発)', color: '#27ae60', bgColor: '#d5f5e3', arrivalMins: nextBus.arrivalMins, data: nextBus }});

            const TRANSFER_TIME = 5;
            let bestJRArrival = null;
            let bestOption = null;
            let isTied = false;
            let tiedOptions = [];

            // それぞれの選択肢で乗れる最速のJRを探す
            for (let opt of options) {{
                const kurashikiArrMins = opt.arrivalMins;
                const nextJR = getNextRide('jr-table-return', kurashikiArrMins + TRANSFER_TIME);
                if (nextJR) {{
                    opt.jr = nextJR;
                    if (bestJRArrival === null || nextJR.arrivalMins < bestJRArrival) {{
                        bestJRArrival = nextJR.arrivalMins;
                        bestOption = opt;
                        tiedOptions = [opt];
                        isTied = false;
                    }} else if (nextJR.arrivalMins === bestJRArrival) {{
                        tiedOptions.push(opt);
                        isTied = true;
                    }}
                }}
            }}

            if (tiedOptions.length === 0) {{
                resultBox.innerHTML = '<span style="color: red;">倉敷駅まで行けますが、西阿知方面のJR接続がありません。</span>';
                return;
            }}

            // Highlight JR
            const bestJR = tiedOptions[0].jr; // どちらでも乗るJRは同じ場合が多い
            
            let recommendation = "";
            if (!isTied) {{
                recommendation += `おすすめ: <span style="color: ${{bestOption.color}};">${{bestOption.name}}</span> (${{bestOption.data.departure}}発 → 倉敷 ${{bestOption.data.arrival}}着)<br>`;
                recommendation += `接続JR: 倉敷 ${{bestOption.jr.departure}}発 → 西阿知 ${{bestOption.jr.arrival}}着`;
                bestOption.data.element.style.backgroundColor = bestOption.bgColor;
                bestOption.jr.element.style.backgroundColor = '#ebdef0';
                scrollRowToCenter(bestOption.jr.element);
            }} else {{
                // どちらを使っても同じJRに間に合う場合
                recommendation += `おすすめ: どちらを使っても同じJRに間に合います<br>`;
                recommendation += tiedOptions.map(opt => `<span style="color: ${{opt.color}};">${{opt.name}}</span> (${{opt.data.departure}}発 → ${{opt.data.arrival}}着)`).join(' / ') + "<br>";
                recommendation += `接続JR: 倉敷 ${{bestJR.departure}}発 → 西阿知 ${{bestJR.arrival}}着`;
                tiedOptions.forEach(opt => opt.data.element.style.backgroundColor = opt.bgColor);
                bestJR.element.style.backgroundColor = '#ebdef0';
                scrollRowToCenter(bestJR.element);
            }}

            resultBox.innerHTML = recommendation;
        }}

        // 初期表示時に現在時刻をセット
        window.onload = formatTime;
    </script>
</body>
</html>"""

with open("timetable.html", "w", encoding="utf-8") as f:
    f.write(html_template)
print("Updated timetable.html")
