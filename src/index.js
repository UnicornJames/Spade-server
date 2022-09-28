const express = require("express");
const app = express();
const cors = require("cors");
const bodyParser = require("body-parser");
const web3 = require("web3");
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });
const { MongoClient, ObjectId } = require("mongodb");
const moment = require("moment");
const CronJob = require("cron").CronJob;
const axios = require("axios").default;

// // set server timezone to UTC
// process.env.TZ = "UTC";

app.use(cors());
app.use(bodyParser.json());

const ethApi = require("etherscan-api").init(
  "V9NP1HTIADE3VRWGGZ6SWPYGVX3BN83KEP",
);

const url =
  "mongodb+srv://jameshiro:XY0gA4UPqXdrAd2f@cluster0.gx0wfrc.mongodb.net/test";
const client = new MongoClient(url);

(async () => {
  await client.connect();
  console.log("Connected successfully to MongoDB server");
  const db = client.db("reserve-test");
  const reservesCollection = db.collection("reserves");
  const chartCollection = db.collection("chart");
  const reserveBaseCollection = db.collection("reserve_base");
  const statisticsCollection = db.collection("statistics");
  const assetsCollection = db.collection("assets");
  const usersCollection = db.collection("users");
  const borrowRequestsCollection = db.collection("borrow_requests");
  const commandsCollection = db.collection("commands");
  const auditsCollection = db.collection("audits");
  const depositoriesCollection = db.collection("depositories");

  app.get("/audits", async (req, res) => {
    res.json(await auditsCollection.find({}).toArray());
  });

  app.get("/depositories", async (req, res) => {
    res.json(await depositoriesCollection.find({}).toArray());
  });

  app.get("/assets", async (req, res) => {
    res.json(await getAssets());
  });

  app.get("/asset/:asset_id", async (req, res) => {
    const id = req.params.asset_id.split("-");
    const asset = await assetsCollection.findOne({ _id: ObjectId(id[0]) });
    let response = null;
    if (id.length > 1) {
      response = asset.sub_assets[parseInt(id[1])];
    } else {
      response = {
        ...asset,
        total_collateral: asset.sub_assets.reduce(
          (sum, v) => sum + v.total_collateral,
          0,
        ),
        total_borrowed: asset.sub_assets.reduce(
          (sum, v) => sum + v.total_borrowed,
          0,
        ),
        reserve_size: asset.sub_assets.reduce(
          (sum, v) => sum + v.reserve_size,
          0,
        ),
        // Cash
        available_liquidity: asset.sub_assets.reduce(
          (sum, v) => sum + v.available_liquidity,
          0,
        ),
        _id: undefined,
        sub_assets: undefined,
      };
    }
    res.json(response);
  });

  app.post("/borrow-request", async (req, res) => {
    const market = await borrowRequestsCollection.insertOne({
      first_name: req.body.firstName,
      last_name: req.body.lastName,
      email: req.body.email,
      phone: req.body.phone,
      inquiry: req.body.inquiry,
      collateral: req.body.collateral,
      message: req.body.message,
    });
    res.json({ message: "Borrow request submitted successfully" });
  });

  app.post("/signin", async (req, res) => {
    const user = await usersCollection.findOne({
      email: req.body.email,
      password: req.body.password,
    });
    if (user) {
      res.json({
        status: true,
        message: "Sign in successfull",
        data: { ...user, password: undefined },
      });
    } else {
      res.json({
        status: false,
        message: "Invalid email or password",
      });
    }
  });

  app.post("/command", async (req, res) => {
    const command = await commandsCollection.findOne({
      name: req.body.name,
    });
    if (command) {
      res.json({
        status: true,
        command,
      });
    } else {
      res.json({
        status: false,
        message: "Command not found",
      });
    }
  });

  let reserve = null;
  let statistics = null;
  let stablecoins = 0;
  let rebalance = 0;
  let chartData = null;

  const getAssets = async () => {
    const assets = await assetsCollection.find({}).toArray();

    const response = assets.map((asset) => ({
      ...asset,
      // cash
      available_liquidity: asset.sub_assets.reduce(
        (sum, v) => sum + v.available_liquidity,
        0,
      ),
      // borrow
      total_borrowed: asset.sub_assets.reduce(
        (sum, v) => sum + v.total_borrowed,
        0,
      ),
      reserve_size: asset.sub_assets.reduce(
        (sum, v) => sum + v.reserve_size,
        0,
      ),
      // high quality
      total_collateral: asset.sub_assets.reduce(
        (sum, v) => sum + v.total_collateral,
        0,
      ),
    }));
    return response;
  };

  const loadReserves = async () => {
    let reservesData = await reservesCollection.find({}).toArray();
    const reserveBaseData = await reserveBaseCollection.find({}).toArray();
    const assets = await getAssets();
    // total cash
    reservesData[0].assets[0].total = assets.reduce(
      (sum, v) => sum + v.available_liquidity,
      0,
    );
    // total HQLA
    reservesData[0].assets[1].total = assets.reduce(
      (sum, v) => sum + v.total_collateral,
      0,
    );

    // Real Estate
    reservesData[2].assets[0].total = assets[0].total_collateral;
    // Digital Assets
    reservesData[2].assets[1].total = assets[1].total_collateral;
    // Commodities
    reservesData[2].assets[2].total = assets[2].total_collateral;
    // Stocks
    reservesData[2].assets[3].total = assets[3].total_collateral;

    // Stablecoins
    reservesData[1].assets[0].items[3].total = stablecoins;

    // all total
    reservesData[0] = reservesData[0] = {
      ...reservesData[0],
      total: reservesData[0].assets.reduce((sum, v) => sum + (v.total || 0), 0),
    };
    reservesData[1] = {
      ...reservesData[1],
      total: [
        ...reservesData[1].assets[0].items,
        ...reservesData[1].assets[1].items,
      ].reduce((sum, v) => sum + (v.total || 0), 0),
    };
    reservesData[2] = {
      ...reservesData[2],
      total: reservesData[2].assets.reduce((sum, v) => sum + (v.total || 0), 0),
    };

    // new cash and high quality value
    reservesData[0].assets[0].total =
      reservesData[0].assets[0].total - reservesData[1].total;
    reservesData[0].assets[1].total =
      reservesData[0].assets[1].total + reservesData[1].total;

    var current_chartdata = [
      reservesData[0].assets[0].total,
      reservesData[0].assets[1].total,
      reservesData[1].total,
    ];
      
    await addChartData(current_chartdata);

    // change calculation
    reservesData.forEach((_, i) => {
      const diff = reservesData[i].total - reserveBaseData[i].value;
      reservesData[i].change = parseFloat(
        ((diff / reserveBaseData[i].value) * 100).toFixed(2),
      );
    });

    reserve = reservesData;
  };

  const addChartData = async (chartdata) => {
    await chartCollection.deleteMany({
      timestamp: { $lt: new Date().getTime() - 604800000 },
      // timestamp: { $lt: 1664250010639 },
    });

    await chartCollection.insertOne({
      timestamp: new Date().getTime(),
      total: [
        chartdata[0], // cash data
        chartdata[1], // high quality liquid
        chartdata[2], // borrow data
      ],
    });
  };

  const loadStatistics = async () => {
    const statisticsData = await statisticsCollection.findOne({});
    statistics = statisticsData;
    statistics["24h_volume"] += stablecoins;
    statistics["30d_volume"] += stablecoins;
    statistics["24h_rebalancing"] += rebalance;
  };

  // fetch etherium balance
  const updateEthBalance = async () => {
    try {
      const totalEthBalance = (
        await ethApi.account.balance([
          "0x6165fd87c1bc73a4c44b23934e9136fd92df5b01",
          "0xca8fa8f0b631ecdb18cda619c4fc9d197c8affca",
        ])
      ).result.reduce(
        (sum, v) => sum + parseFloat(web3.utils.fromWei(v.balance, "ether")),
        0,
      );
      const usdRate = parseFloat((await ethApi.stats.ethprice()).result.ethusd);
      const totalUsdValue = parseFloat((totalEthBalance * usdRate).toFixed(2));
      const digitalAsset = await assetsCollection.findOne({
        _id: ObjectId("62f3e0a607e8acd97d37becd"),
      });
      const ethIndex = digitalAsset.sub_assets.findIndex(
        (v) => v.name == "Ethereum",
      );
      if (digitalAsset.sub_assets[ethIndex].total_collateral != totalUsdValue) {
        await statisticsCollection.updateOne(
          { _id: ObjectId("62f3d45007e8acd97d37bec6") },
          {
            $set: {
              last_recorded: `${moment()
                .utc()
                .format("DD/MM/YYYY hh:mm:ss A")} UTC`,
            },
          },
        );
      }
      digitalAsset.sub_assets[ethIndex].total_collateral = totalUsdValue;
      await assetsCollection.updateOne(
        {
          _id: ObjectId("62f3e0a607e8acd97d37becd"),
        },
        { $set: { sub_assets: digitalAsset.sub_assets } },
      );
    } catch (error) {
      // console.log(error);
    }
  };

  // fetch stablecoins balance
  const fetchStableCoinBalance = async () => {
    try {
      const totalEthBalance = parseFloat(
        web3.utils.fromWei(
          (
            await ethApi.account.balance(
              "0x899cbf7c9f5d784997676d6a680b91e21671d40e",
            )
          ).result,
          "ether",
        ),
      );
      const usdRate = parseFloat((await ethApi.stats.ethprice()).result.ethusd);
      const totalUsdValue = parseFloat((totalEthBalance * usdRate).toFixed(2));
      stablecoins = totalUsdValue;
      await statisticsCollection.updateOne(
        { _id: ObjectId("62f3d45007e8acd97d37bec6") },
        {
          $set: {
            stablecoin_last_recorded: `${moment()
              .utc()
              .format("DD/MM/YYYY hh:mm:ss A")} UTC`,
          },
        },
      );
    } catch (error) {
      // console.log(error);
    }
  };

  // fetch rebalance
  const fetchRebalance = async () => {
    try {
      const totalEthBalance = parseFloat(
        web3.utils.fromWei(
          (
            await ethApi.account.balance(
              "0x333d2e2b987a7c01ce56432151274a6630e2cf1b",
            )
          ).result,
          "ether",
        ),
      );
      const usdRate = parseFloat((await ethApi.stats.ethprice()).result.ethusd);
      const totalUsdValue = parseFloat((totalEthBalance * usdRate).toFixed(2));
      rebalance = totalUsdValue;
    } catch (error) {
      // console.log(error);
    }
  };

  // load bitcoin price
  const fetchBitcoinPrice = async () => {
    try {
      const { data } = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price",
        { params: { ids: "bitcoin", vs_currencies: "usd" } },
      );
      const digitalAsset = await assetsCollection.findOne({
        _id: ObjectId("62f3e0a607e8acd97d37becd"),
      });
      const btcIndex = digitalAsset.sub_assets.findIndex(
        (v) => v.name == "Bitcoin",
      );
      digitalAsset.sub_assets[btcIndex].total_collateral =
        data.bitcoin.usd * digitalAsset.sub_assets[btcIndex].quantity;
      await assetsCollection.updateOne(
        {
          _id: ObjectId("62f3e0a607e8acd97d37becd"),
        },
        { $set: { sub_assets: digitalAsset.sub_assets } },
      );
    } catch (error) {
      // console.log(error);
    }
  };

  const fetchSingleStockPrice = async (symbol) => {
    const { data } = await axios.get("https://www.alphavantage.co/query", {
      params: {
        function: "TIME_SERIES_INTRADAY",
        symbol,
        interval: "1min",
        apikey: "BWN73Y4EU1N21Y8V",
      },
    });

    return parseFloat(
      Object.values(Object.values(Object.values(data)[1])[0])[0],
    );
  };

  const updateStocksPrices = async () => {
    try {
      const stockIds = ["AAPL", "MSFT", "AMZN", "GOOGL"];
      const prices = await Promise.all(
        stockIds.map((v) => fetchSingleStockPrice(v)),
      );
      const stocksAsset = await assetsCollection.findOne({
        _id: ObjectId("62f3e0bd07e8acd97d37becf"),
      });
      stockIds.forEach((symbol, i) => {
        const index = stocksAsset.sub_assets.findIndex(
          (v) => v.symbol == symbol,
        );
        stocksAsset.sub_assets[index].total_collateral =
          prices[i] * stocksAsset.sub_assets[index].quantity;
      });
      await assetsCollection.updateOne(
        {
          _id: ObjectId("62f3e0bd07e8acd97d37becf"),
        },
        { $set: { sub_assets: stocksAsset.sub_assets } },
      );
    } catch (error) {
      // console.log(error);
    }
  };

  const updateCommoditiesPrices = async () => {
    try {
      const symbols = ["WTIOIL", "BRENTOIL", "NG", "XAU"];
      const { data } = await axios.get(
        "https://commodities-api.com/api/latest",
        {
          params: {
            access_key:
              "3e55dhjswyyy4d92y3n4anx4dpfvynpvqjzbsw72llich878n504cf8ya2cn",
            base: "USD",
            symbols: symbols.join(","),
          },
        },
      );
      const commodityAsset = await assetsCollection.findOne({
        _id: ObjectId("62f3e0b207e8acd97d37bece"),
      });
      symbols.forEach((symbol, i) => {
        const index = commodityAsset.sub_assets.findIndex(
          (v) => v.symbol == symbol,
        );
        const price = 1 / data.data.rates[symbol];
        commodityAsset.sub_assets[index].total_collateral =
          price * commodityAsset.sub_assets[index].quantity;
      });
      await assetsCollection.updateOne(
        {
          _id: ObjectId("62f3e0b207e8acd97d37bece"),
        },
        { $set: { sub_assets: commodityAsset.sub_assets } },
      );
    } catch (error) {
      // console.log(error);
    }
  };

  const getChartData = async () => {
    chartData = await chartCollection.find({}).toArray();
  };

  setInterval(async () => {
    await updateStocksPrices();
  }, 1000 * 60 * 2);

  setInterval(async () => {
    await fetchStableCoinBalance();
  }, 1000 * 60 * 30);

  setInterval(async () => {
    if (io.engine.clientsCount) {
      await Promise.all([
        updateEthBalance(),
        fetchRebalance(),
        loadReserves(),
        loadStatistics(),
        fetchBitcoinPrice(),
      ]);

      io.emit("reserve", reserve);
      io.emit("statistics", statistics);
      io.emit("servertime", new Date().getTime());
    }
  }, 5000);

  await Promise.all([
    updateEthBalance(),
    fetchRebalance(),
    fetchStableCoinBalance(),
    loadReserves(),
    getChartData(),
    loadStatistics(),
    fetchBitcoinPrice(),
  ]);

  new CronJob(
    "0 0 * * *",
    async () => {
      if (reserve) {
        await Promise.all([
          reserveBaseCollection.updateOne(
            { title: "reserve" },
            { $set: { value: reserve[0].total } },
          ),
          reserveBaseCollection.updateOne(
            { title: "borrow" },
            { $set: { value: reserve[1].total } },
          ),
          reserveBaseCollection.updateOne(
            { title: "collateral" },
            { $set: { value: reserve[2].total } },
          ),
        ]);
      }
    },
    null,
    true,
    "UTC",
  );

  new CronJob(
    "0 10,15,20 * * *",
    async () => {
      await updateCommoditiesPrices();
    },
    null,
    true,
    "UTC",
  );

  io.on("connection", async (socket) => {
    socket.on("reserve", () => {
      io.emit("reserve", reserve);
    });
    socket.on("statistics", () => {
      io.emit("statistics", statistics);
    });
    socket.on("getchartdata", () => {
      io.emit("getchartdata", chartData);
    });
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log("listening on *:" + port);
  });
})();
